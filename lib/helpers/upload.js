'use strict';

var googleapis = require('googleapis');
var async = require('async');
var rarity = require('rarity');
var log = require('anyfetch-provider').log;


var managePart = require('./manage-part.js');
var config = require('../../config/configuration.js');

function mergeThreadDate(mails) {
  if(mails[0] && mails[0].payload && mails[0].payload.headers) {
    var date = "";
    mails[0].payload.headers.forEach(function walkHeaders(header) {
      if(header.name === 'Date') {
        date = new Date(header.value);
      }
    });
    return date;
  }
  return new Date();
}

function mergeThreadLabels(mails) {
  var labelsBuffer = {};
  mails.forEach(function walkMails(mail) {
    if(mail.labelIds) {
      mail.labelIds.forEach(function walkLabels(label) {
        labelsBuffer[label] = true;
      });
    }
  });
  return Object.keys(labelsBuffer);
}

function mergeThreadSubject(mails) {
  if(mails[0]) {
    var subject = "No Subject";
    (mails[0].payload.headers || []).forEach(function walkHeaders(header) {
      if(header.name === 'Subject') {
        subject = header.value;
      }
    });
    return subject;
  }
  return "";
}

function mergeThreadParticipants(mails) {
  var buffer = {};
  mails.forEach(function walkMails(mail) {
    if(!mail) {
      return;
    }

    function walkAddresses(obj) {
      if(obj.name && obj.name.length > 0) {
        buffer[obj.address] = obj.name;
      }
      else if(! buffer[obj.address]) {
        buffer[obj.address] = "";
      }
    }

    (mail.from || []).forEach(walkAddresses);
    (mail.to || []).forEach(walkAddresses);
    (mail.cc || []).forEach(walkAddresses);
  });
  return Object.keys(buffer).map(function walkBuffer(address) {
    var obj = {};
    if(address.length > 0) {
      obj.address = address;
    }
    if(buffer[address]) {
      obj.name = buffer[address];
    }
    return obj;
  });
}


var retrieveThreadDetails = function(thread, anyfetchClient, serviceData, oauth2Client, finalCb) {
  async.waterfall([
    function retrieveThreadData(cb) {
      var options = {
        id: thread.id,
        userId: serviceData.accountName,
        auth: oauth2Client
      };

      googleapis.gmail('v1').users.threads.get(options, rarity.slice(2, cb));
    },
    function mergeData(threadData, cb) {
      threadData.url = thread.identifier;
      var documentDate = mergeThreadDate(threadData.messages);

      var document = {
        identifier: threadData.url,
        data: {
          id: thread.id
        },
        metadata: {
          labels: mergeThreadLabels(threadData.messages),
          subject: mergeThreadSubject(threadData.messages),
          date: documentDate,
          participants: [],
          attachmentsCount: 0
        },
        actions: {
          show: threadData.url
        },
        related: [],
        document_type: 'email-thread',
        creation_date: documentDate,
        user_access: [anyfetchClient.accessToken],
      };

      cb(null, threadData, document);
    },
    function parseThreadParts(threadData, document, cb) {
      var attachments = [];
      document.data.messages = [];
      document.metadata.messages = [];

      async.eachSeries(threadData.messages, function parseMailParts(mailData, cb) {
        if(mailData.payload) {
          return managePart(mailData, mailData.payload, document, attachments, serviceData, oauth2Client, function addToMessagesList() {
            document.data.messages.push(mailData.data || {});
            document.metadata.messages.push(mailData.metadata || {});
            cb();
          });
        }
        cb();
      }, rarity.carry([attachments, document], cb));
    },
    function finishMerge(attachments, document, cb) {
      document.metadata.participants = mergeThreadParticipants(document.metadata.messages);
      cb(null, attachments, document);
    },
    function sendDocument(attachments, document, cb) {
      log.info({
        name: 'addition',
        identifier: document.identifier,
      }, "Uploading");
      anyfetchClient.postDocument(document, rarity.carryAndSlice([attachments, document], 3, cb));
    },
    function sendAttachments(attachments, document, cb) {
      async.each(attachments, function(attachment, cb) {
        log.info({
          name: 'addition',
          identifier: attachment.document.identifier
        }, "Uploading");
        anyfetchClient.sendDocumentAndFile(attachment.document, attachment.fileToSend, rarity.slice(1, cb));
      }, cb);
    }
  ], finalCb);
};

module.exports = function uploadThread(thread, anyfetchClient, serviceData, cache, cb) {
  var oauth2Client = new googleapis.auth.OAuth2(config.googleId, config.googleSecret, serviceData.callbackUrl);
  oauth2Client.credentials = serviceData.tokens;

  retrieveThreadDetails(thread, anyfetchClient, serviceData, oauth2Client, cb);
};
