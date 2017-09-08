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
      welcome_msgs = require('./welcome_msgs.json').msgs;

const GRAPH_API_BASE = 'https://graph.facebook.com/v2.10';

if (!(config.app_id &&
      config.app_secret &&
      config.verify_token &&
      config.access_token &&
      config.org_name)) {
  console.error('Missing config values');
  process.exit(1);
}

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

function sendMessage(id, msg, cb) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: '/me/messages',
    qs: { access_token: config.access_token },
    method: 'POST',
    json: msg
    }
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

function send:ListOfMessages(id, msgs, cb) {
  function sendSingleMessage(index, cb) {
    if (index < msgs.length) {
      var msg = new Object();
      msg.recipient.id = id;
      msg.message = msgs[index];
      sendMessage(id, msg, () => sendSingleMessage(index + 1));
    } else if (cb) {
      cb();
    }
  }
  sendSingleMessage(0, cb);
}

function sendRequest(url, method, json) {
}

function pageCallback(data) {
  data.entry.forEach(function(pageEntry) {
    pageEntry.messaging.forEach(function(messagingEvent) {
      if (messagingEvent.message) {
        var user_id = messagingEvent.sender.id;
        sendWelcomeMsgs(user_id);
      }
    });
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
        cb(body.name.split(' ')[0]);
      }
    } else {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
  });
}

function replyChatMsgs(user_id) {
  getUserFirstName(user_id, name => {
    sendMessage(messagingEvent.sender.id,
                `Sorry ${name}, I am not programmed to chat with you :(`);
  });

}

function sendWelcomeMsgs(user_id) {
  getUserFirstName(user_id, name => {
    sendMessage(
        user_id,
        `Hello ${name}, welcome to ${config.org_name} :)`,
        () => sendListOfMessages(user_id, welcome_msgs));
  });
}

function securityCallback(data) {
  data.entry.forEach(function(entry) {
    entry.changes.forEach(function(change) {
      if (change.field == 'admin_activity') {
        if (change.value.event == 'ADMIN_ACTIVATE_ACCOUNT') {
          var user_id = change.value.target_id;
          console.log("New Account Created, sending message to new user " + user_id);
          sendWelcomeMsgs(user_id);
        }
      }
    });
  });
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

  // Make sure this is a page subscription
  if (data.object == 'page') {
    pageCallback(data);
    res.sendStatus(200);
  } else if (data.object == 'workplace_security') {
    securityCallback(data);
    res.sendStatus(200);
  }
});

app.listen(app.get('port'), function() {
  console.log('welcome_bot is running on port', app.get('port'));
});

module.exports = app;
