/*
 * Copyright 2016-present, McGill Robotics
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';
const
      bodyParser = require('body-parser'),
      crypto = require('crypto'),
      express = require('express'),
      request = require('request'),
      config = require('./config.json'),
      sqlite3 = require('sqlite3'),
      welcome_msgs = require('./welcome_msgs.json').msgs;

const GRAPH_API_BASE = 'https://graph.facebook.com/v2.10';

var debug_mode = (process.env.DEBUG == 'true' ? true : false);
console.log(`Debug Mode: ${debug_mode}`);

if (!(config.app_id &&
      config.app_secret &&
      config.verify_token &&
      config.access_token &&
      config.org_name &&
      config.activity_log &&
      config.log_table_name)) {
  console.error('Missing config values');
  process.exit(1);
}

var activity_log = new sqlite3.Database(config.activity_log);
var app = express();

app.set('port', config.port);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

function verifyRequestSignature(req, res, buf) {
  var signature = req.headers['x-hub-signature'];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error('Signature missing.');
  } else {
    var elements = signature.split('=');
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', config.app_secret)
      .update(buf)
      .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error('Couldn\'t validate the request signature.');
    }
  }
}

function sendMessage(msg, cb) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: '/me/messages',
    qs: { access_token: config.access_token },
    method: 'POST',
    json: msg
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;
      if (cb) {
        cb(recipientId, messageId);
      }
    } else {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
  });
}

function sendListOfMessages(id, msgs, cb) {
  function sendSingleMessage(index, cb) {
    if (index < msgs.length) {
      var msg = new Object();
      msg.recipient = { id: id };
      msg.message = msgs[index];
      sendMessage(msg, () => sendSingleMessage(index + 1));
    } else if (cb) {
      cb();
    }
  }
  sendSingleMessage(0, cb);
}

function printObj(obj) {
  console.log(JSON.stringify(obj, null, 4));
}

function getAllUsers(cb) {
  function getUser(after, user_list, cb){
    var url = '/community/members';
    if (after) {
      url = url + '?after=' + after;
    }
    request({
      baseUrl: GRAPH_API_BASE,
      url: url,
      qs: { access_token: config.access_token},
      method: 'GET',
      json: true
    }, function (error, res, body) {
      if (!error && res.statusCode == 200) {
        // printObj(body);
        if (body.data.length) {
          // Add more user to the user list and request more.
          body.data.forEach( function(user) {
            user_list.push(user);
          });
          printDebug('Getting next page');
          printDebug('Total users so far: ' + user_list.length);
          getUser(body.paging.cursors.after, user_list, cb);
        } else {
          if (cb){
            printDebug('Total users: ' + user_list.length);
            cb(user_list);
          }
        }
      } else {
        console.error('Failed to get user', res.statusCode, res.statusMessage, body.error);
      }
    });
  }

  printDebug('Getting all users');
  getUser(0, [], cb);
}
function printDebug(msg) {
  if (debug_mode) {
    if(typeof msg == 'string'){
      console.log(msg);
    } else {
      printObj(msg);
    }
  }
}

function secondsToString(time) {
  var ret = '';
  if (time > 0) {
    ret = time % 60 + 's ' + ret;
    time = Math.floor(time / 60);
    if (time > 0) {
      ret = time % 60 + 'min '+ret;
      time = Math.floor(time / 60);
      if (time > 0) {
        ret = time % 60 + 'h ' + ret;
        time = Math.floor(time / 24);
        if ( time > 0 ) {
          ret = time + 'd ' + ret;
        }
      }
    }
  }
  return ret;
}

function deactivateUser(user) {
  console.log(`User ${user} is now deactivated`);
}

function checkInactivity(){
  getAllUsers((users) => {
    var time_now = Math.floor((new Date).getTime() / 1000);
    users.forEach((user) => {
      var sql = `SELECT * FROM ${config.log_table_name}`
                + ` WHERE user_id=${user.id}`;
      activity_log.get(sql, [], (err, data) =>{
        if (!err) {
          if (data) {
            var inactive_time = time_now - Math.floor(data.last_activity);
            if (inactive_time > 0) {
              printDebug(`${user.id}: ${secondsToString(inactive_time)}`);
              if(inactive_time > 30 * 24 * 60 * 60 && !data.warning_sent){
                console.log(`User ${user.id} has been inactive for awhile, warning sent.`);
                var msg = `${user.name} has been inactive for awhile, warning sent.`;
                sendAdminsMsg(msg);
                activity_log.run(`REPLACE INTO ${config.log_table_name} `
                  + 'VALUES (?, ?, 1);', user.id, data.last_activity);
              } else if (inactive_time > 45 * 24 * 60 * 60 && data.warning_sent){
                console.log(`Disactivate user ${user.id} due to inactivity.`);
                sendAdminsMsg(`${user.name} has been`
                    + ' marked to be deactivated due to  inactivity');
                activity_log.run(`DELETE FROM ${config.log_table_name}`
                    + ` WHERE user_id=${user.id};`);
                deactivateUser(user.id);
              }
            }
          } else {
            printDebug(`${user.id}: No data. Skipping...`);
          }
        }
      });
    });
  });
}

function isAdmin(id) {
  for(var i = 0; i < config.admins.length; i++){
    if (id == config.admins[i]){
      return true;
    }
  }
  return false;
}

function pageCallback(data) {
  data.entry.forEach(function(pageEntry) {
    pageEntry.messaging.forEach(function(messagingEvent) {
      if (messagingEvent.message) {
        var user_id = messagingEvent.sender.id;
        if (isAdmin(user_id)){
          checkInactivity();
          sendAdminsMsg(`Inativity check initiated by ${user_id}`);
        } else {
          processSetupComplete(user_id);
        }
      } else if (messagingEvent.postback) {
        processPostback(messagingEvent);
      }
    });
  });
}

function processPostback(msg) {
  switch(msg.postback.payload) {
    case "SETUP_COMPLETED_PAYLOAD":
      processSetupComplete(msg.sender.id);
      break;
    default:
      console.error('Unknown payload: ' + msg.postback.payload);
  }
}

function processSetupComplete(user_id) {
  getUserProfile(user_id, (profile) => {
    var missed_fields = checkMissedFields(profile);
    if (missed_fields.length) {
      var msg = "Your profile is still missing ";
      if (missed_fields.length > 1) {
        for (var i=0; i < (missed_fields.length - 1); i++){
          msg = msg + missed_fields[i] + ', '
        }
        msg = msg + 'and ';
      }
      msg = msg + missed_fields.slice(-1)[0] + ' :(';
      sendQuickPbButton(user_id, msg, 'Try again', 'SETUP_COMPLETED_PAYLOAD');
    } else {
      sendQuickMsg(user_id, 'Your profile is complete, you are all set :D');
    }
  });
}

function sendQuickPbButton(id, text, button_title, payload) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: '/me/messages',
    qs: { access_token: config.access_token },
    method: 'POST',
    json: {
      'recipient' : { 'id': id },
      'message': {
        'attachment':{
          'type': 'template',
          'payload':{
            'template_type': 'button',
            'text': text,
            "buttons": [
              { 'type': 'postback', 'title': button_title, 'payload': payload }
            ]
          }
        }
      }
    }
  }, function (error, response, body) {
    if (error || response.statusCode != 200) {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
  });
}

function sendAdminsMsg(msg) {
  config.admins.forEach( (admin) => {
    sendQuickMsg(admin, msg);
  });
}


function sendQuickMsg(id, text) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: '/me/messages',
    qs: { access_token: config.access_token },
    method: 'POST',
    json: { 'recipient' : { 'id': id }, 'message': { 'text' : text } }
  }, function (error, response, body) {
    if (error || response.statusCode != 200) {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
  });
}

function checkMissedFields(profile) {
  var missed_fields = [];
  if (!profile.cover){
    missed_fields.push('a cover photo');
  }

  if (profile.picture.data.is_silhouette) {
    missed_fields.push('a profile picture');
  }

  if (!profile.department) {
    missed_fields.push('a department');
  }

  if (!profile.title) {
    missed_fields.push('a position');
  }

  if (!profile.managers) {
    missed_fields.push('a manager');
  }

  return missed_fields;
}

function getUserProfile(user_id, cb) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: `/${user_id}?fields=cover,picture,department,title,managers`,
    qs: { access_token: config.access_token },
    method: 'GET',
    json: true
  }, (err, res, body) => {
    if (!err && res.statusCode == 200) {
      if (cb) {
        cb(body);
      }
    } else {
      console.error('Failed sending message', res.statusCode, res.statusMessage, body.error);
    }
  });
}

function getUserFirstName(user_id, cb) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: `/${user_id}`,
    qs: { access_token: config.access_token },
    method: 'GET',
    json: true
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      if (cb) {
        cb(body.first_name);
      }
    } else {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
  });
}

function sendWelcomeMsgs(user_id) {
  getUserFirstName(user_id, name => {
    var msg = new Object();
    msg.recipient = { id: user_id };
    msg.message = { text : `Hello ${name}, welcome to ${config.org_name} :)` };
    sendMessage(msg, () => sendListOfMessages(user_id, welcome_msgs));
  });
}

function updateActivityLog(user_id, time) {
  console.log(`Update last activity for ${user_id}`);
  activity_log.run(`INSERT OR REPLACE INTO ${config.log_table_name} `
                   + 'VALUES (?, ?, 0);', user_id, time);
}

function securityCallback(data) {
  data.entry.forEach(function(entry) {
    // printObj(entry);
    var time = entry.time;
    entry.changes.forEach(function(change) {
      if (change.field == 'sessions') {
        if (change.value.event == 'LOG_IN') {
          updateActivityLog(change.value.target_id, time)
        }
      }
      if (change.field == 'admin_activity') {
        // printObj(change);
        if (change.value.event == 'ADMIN_ACTIVATE_ACCOUNT' ||
            change.value.event == 'ADMIN_CREATE_ACCOUNT') {
          var user_id = change.value.target_id;
          console.log("Account created/activated, sending message to new user " + user_id);
          sendWelcomeMsgs(user_id);
        }
      }
    });
  });
}

function userActivityCallback(data){
  switch (data.object) {
    case 'group':
      data.entry.forEach(function(entry) {
        var time = entry.time;
        entry.changes.forEach(function(change) {
          var type = change.field;
          if (type == 'comments' || type == "posts") {
            updateActivityLog(change.value.from.id, time);
          } else {
            console.error(`Unknown group change type: ${type}`);
            printObj(change);
          }
        });
      });
      break;
    case 'user':
      data.entry.forEach(function(entry) {
        var time = entry.time;
        var user_id = entry.id;
        entry.changes.forEach(function(change) {
          var type = change.field;
          if (type == 'events') {
            updateActivityLog(user_id, time);
          } else {
            console.error(`Unknown user change type: ${type}`);
            printObj(change);
          }
        });
      });
      break;
    default:
      console.error('Unkwon activity type');
      printObj(data);
  }
}

app.get('/welcome', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === config.verify_token) {
    console.log('Validated webhook.');
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error('Failed validation. Make sure the validation tokens match.');
    res.sendStatus(403);
  }
});

app.post('/welcome', function (req, res) {
  var data = req.body;
  printDebug('Received Webhook:');
  printDebug(data);
  // Make sure this is a page subscription
  if (data.object == 'page') {
    pageCallback(data);
    res.sendStatus(200);
  } else if (data.object == 'workplace_security') {
    securityCallback(data);
    res.sendStatus(200);
  } else {
    res.sendStatus(200);
    userActivityCallback(data);
  }
});

app.listen(app.get('port'), function() {
  console.log('welcome_bot is running on port', app.get('port'));
});

module.exports = app;
