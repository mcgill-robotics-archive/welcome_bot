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
           config = require('./config.json');

const GRAPH_API_BASE = 'https://graph.facebook.com/v2.10';

if (!(config.app_id &&
      config.app_secret &&
      config.verify_token &&
      config.access_token &&
      config.server_url)) {
  console.error('Missing config values');
  process.exit(1);
}
console.log('port: ' + config.port);
console.log('verify_token: ' + config.verify_token);

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

function sendMessage(id, text) {
  request({
    baseUrl: GRAPH_API_BASE,
    url: '/me/messages',
    qs: { access_token: config.access_token },
    method: 'POST',
    json: {
      recipient: {
        id: id
      },
      message: {
        text: text
      }
    }
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;
    } else {
      console.error('Failed sending message', response.statusCode, response.statusMessage, body.error);
    }
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
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.message) {
          sendMessage(messagingEvent.sender.id,
                      'Sorry, I can\'t reply to messages yet :(');
        }
      });
    });
    res.sendStatus(200);
  } else if (data.object == 'workplace_security') {
    if (data.entry.changes.value.event == 'ADMIN_CREATE_ACCOUNT') {
      console.log('User' + data.entry.changes.value.target_id);
    }
    res.sendStatus(200);
  }
});

app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
