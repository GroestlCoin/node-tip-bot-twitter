var irc    = require('irc')
, winston  = require('winston')
, fs       = require('fs')
, yaml     = require('js-yaml')
, coin     = require('node-dogecoin')
, webadmin = require('../lib/webadmin/app');

// check if the config file exists
if(!fs.existsSync('./config/config.yml')) {
  winston.error('Configuration file doesn\'t exist! Please read the README.md file first.');
  process.exit(1);
}

// handle sigint
process.on('exit', function() {
  winston.info('Exiting...');
  if(client != null) {
    client.disconnect('My master ordered me to leave.');
  }
});

// load settings
var settings = yaml.load(fs.readFileSync('./config/config.yml', 'utf-8'));

// load winston's cli defaults
winston.cli();

// write logs to file
if(settings.log.file) {
  winston.add(winston.transports.File, {
    filename: settings.log.file
  , level: 'info'});
}

// connect to coin json-rpc
winston.info('Connecting to coind...');

var coin = coin({
  host: settings.rpc.host
, port: settings.rpc.port
, user: settings.rpc.user
, pass: settings.rpc.pass
});

coin.getBalance(function(err, balance) {
  if(err) {
    winston.error('Could not connect to %s RPC API! ', settings.coin.full_name, err);
    process.exit(1);
    return;
  }

  var balance = typeof(balance) == 'object' ? balance.result : balance;
  winston.info('Connected to JSON RPC API. Current total balance is %d' + settings.coin.short_name, balance);
})

// run webadmin
if(settings.webadmin.enabled)
{
  winston.info('Running webadmin on port %d', settings.webadmin.port);
  webadmin.app(settings.webadmin.port, coin, settings.webadmin, winston);
}

// connect to the server
winston.info('Connecting to the server...');

var client = new irc.Client(settings.connection.host, settings.login.nickname, {
  port:   settings.connection.port
, secure: settings.connection.secure

, channels: settings.channels
, userName: settings.login.username
, realName: settings.login.realname

, debug: settings.connection.debug
});

// gets user's login status
irc.Client.prototype.getLoginStatus = function(nickname, callback) {
  // request login status
  this.say('NickServ', settings.connection.status_command + ' ' + nickname);

  // wait for response
  var listener = function(from, to, message) {
   // proceed only on NickServ's ACC response
    var regexp = new RegExp('^(\\S+) ' + settings.connection.status_command + ' (\\d)');
    if(from != undefined && from.toLowerCase() == 'nickserv' && regexp.test(message)) {
      var match = message.match(regexp);
      var user  = match[1];
      var level = match[2];

      // if the right response, call the callback and remove this listener
      if(user.toLowerCase() == nickname.toLowerCase()) {
        callback(Number(level));
        this.removeListener('notice', listener);
      }
    }
  }

  this.addListener('notice', listener);
}

// gets a empty coin address
irc.Client.prototype.getAddress = function(nickname, callback) {
  winston.debug('Requesting address for %s', nickname);
  coin.send('getaccountaddress', nickname.toLowerCase(), function(err, address) {
    if(err) {
      winston.error('Something went wrong while getting address. ' + err);
      callback(err);

      return false;
    }

    callback(false, address);
  });
}

String.prototype.expand = function(values) {
  var global = {
    nick: client.nick
  }
  return this.replace(/%([a-zA-Z_]+)%/g, function(str, variable) {
    return typeof(values[variable]) == 'undefined' ? 
      (typeof(settings.coin[variable]) == 'undefined' ? 
        (typeof(global[variable]) == 'undefined' ?
          str : global[variable]) : settings.coin[variable]) : values[variable];
  });
}

// basic handlers
client.addListener('registered', function(message) {
  winston.info('Connected to %s.', message.server);

  client.say('NickServ', 'IDENTIFY ' + settings.login.nickserv_password);
});

client.addListener('error', function(message) {
  winston.error('Received an error from IRC network: ', message);
});

client.addListener('message', function(from, channel, message) {
  var match = message.match(/^(!?)(\S+)/);
  if(match == null) return;
  var prefix  = match[1];
  var command = match[2];

  if(settings.commands[command]) {
    if(channel == client.nick && settings.commands[command].pm === false) return;
    if(channel != client.nick && (settings.commands[command].channel === false || prefix != '!')) return;
  } else {
    return;
  }

  // if pms, make sure to respond to pms instead to itself
  if(channel == client.nick) channel = from;

  // if not that, message will be undefined for some reason
  // todo: find a fix for that
  var msg = message;
  client.getLoginStatus(from, function(status) {
    var message = msg;
    // check if the sending user is logged in (identified) with nickserv
    if(status != 3) {
      winston.info('%s tried to use command `%s`, but is not identified.', from, message);
      client.say(channel, settings.messages.not_identified.expand({name: from}));
      return;
    }

    switch(command) {
      case 'tip':
        var match = message.match(/^.?tip (\S+) (\d+)/);
        if(match == null || match < 3) {
          client.say(channel, 'Usage: !tip <nickname> <amount>')
          return;
        }
        var to     = match[1];
        var amount = Number(match[2]);

        if(to.toLowerCase() == from.toLowerCase()) {
          client.say(channel, settings.messages.self_tip.expand({name: from}));
          return;
        }

        if(amount < settings.coin.min_tip) {
          client.say(channel, settings.messages.tip_too_small.expand({from: from, to: to, amount: amount}));
          return;
        }
        // check balance with min. 5 confirmations
        coin.getBalance(from, settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            client.getAddress(to, function(err, to_address) { // get the address to actually create a new one
              if(err) {
                winston.error('Error in !tip command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }

              coin.send('move', from.toLowerCase(), to.toLowerCase(), amount, function(err, reply) {
                if(err || !reply) {
                  winston.error('Error in !tip command', err);
                  client.say(channel, settings.messages.error.expand({name: from}));
                  return;
                }

                winston.info('%s tipped %s %d%s', from, to, amount, settings.coin.short_name)
                client.say(channel, settings.messages.tipped.expand({from: from, to: to, amount: amount}));
              });
            });
          } else {
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        });
        break;
      case 'address':
        var user = from.toLowerCase();
        client.getAddress(user, function(err, address) {
          if(err) {
            winston.error('Error in !address command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          client.say(channel, settings.messages.deposit_address.expand({name: user, address: address}));
        });
        break;
      case 'balance':
        var user = from.toLowerCase();
        coin.getBalance(user, settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !balance command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          var balance = typeof(balance) == 'object' ? balance.result : balance;

          coin.getBalance(user, 0, function(err, unconfirmed_balance) {
          if(err) {
              winston.error('Error in !balance command', err);
              client.say(channel, settings.messages.balance.expand({balance: balance, name: user}));
              return;
            }

            var unconfirmed_balance = typeof(unconfirmed_balance) == 'object' ? unconfirmed_balance.result : unconfirmed_balance;

            client.say(channel, settings.messages.balance_unconfirmed.expand({balance: balance, name: user, unconfirmed: unconfirmed_balance - balance}));
          })
        });
        break;
      case 'withdraw':
        var match = message.match(/^.?withdraw (\S+)$/);
        if(match == null) {
          client.say(channel, 'Usage: !withdraw <' + settings.coin.full_name + ' address>');
          return;
        }
        var address = match[1];

        coin.validateAddress(address, function(err, reply) {
          if(err) {
            winston.error('Error in !withdraw command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          if(reply.isvalid) {
            coin.getBalance(from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
              if(err) {
                winston.error('Error in !withdraw command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }
              var balance = typeof(balance) == 'object' ? balance.result : balance;

              if(balance < settings.coin.min_withdraw) {
                winston.warn('%s tried to withdraw %d, but min is set to %d', from, balance, settings.coin.min_withdraw);
                client.say(channel, settings.messages.withdraw_too_small.expand({name: from, balance: balance}));
                return;
              }

              coin.sendFrom(from.toLowerCase(), address, balance - settings.coin.withdrawal_fee, function(err, reply) {
                if(err) {
                  winston.error('Error in !withdraw command', err);
                  client.say(channel, settings.messages.error.expand({name: from}));
                  return;
                }

                var values = {name: from, address: address, balance: balance, amount: balance - settings.coin.withdrawal_fee, transaction: reply}
                for(var i = 0; i < settings.messages.withdraw_success.length; i++) {
                  var msg = settings.messages.withdraw_success[i];
                  client.say(channel, msg.expand(values));
                };

                // transfer the rest (usually withdrawal fee - txfee) to bots wallet
                coin.getBalance(from.toLowerCase(), function(err, balance) {
                  if(err) {
                    winston.error('Something went wrong while transferring fees', err);
                    return;
                  }

                  var balance = typeof(balance) == 'object' ? balance.result : balance;
                  coin.move(from.toLowerCase(), settings.login.nickname, balance, function(err) {
                    if(err) {
                      winston.error('Something went wrong while transferring fees', err);
                      return;
                    }
                  });
                });
              });
            });
          } else {
            winston.warn('%s tried to withdraw to an invalid address', from);
            client.say(channel, settings.messages.invalid_address.expand({address: address, name: from}));
          }
        });
        break;
      case 'help':
        for(var i = 0; i < settings.messages.help.length; i++) {
          var message = settings.messages.help[i];
          client.say(channel, message.expand({}));
        }
        break;
      case 'terms':
        for(var i = 0; i < settings.messages.terms.length; i++) {
          var message = settings.messages.terms[i];
          client.say(channel, message.expand({}));
        }
        break;
    }
  });
});