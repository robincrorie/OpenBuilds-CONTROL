process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

// To see console.log output run with `DEBUGCONTROL=true electron .` or set environment variable for DEBUGCONTROL=true
// debug_log debug overhead
DEBUG = false;
if (process.env.DEBUGCONTROL) {
  DEBUG = true;
  console.log('Console Debugging Enabled');
}

function debug_log() {
  if (DEBUG) {
    console.log.apply(this, arguments);
  }
} // end Debug Logger

process.on('uncaughtException', (err) => {
  debug_log(err);
});

debug_log('Starting OpenBuilds CONTROL v' + require('./package').version);

var config = {};
config.webPort = process.env.WEB_PORT || 3000;
config.posDecimals = process.env.DRO_DECIMALS || 2;
config.grblWaitTime = 1;
config.firmwareWaitTime = 4;

var express = require('express');
var app = express();
var http = require('http').Server(app);
var https = require('https');

var ioServer = require('socket.io');
var io = new ioServer();
var safetosend;

var fs = require('fs');
var path = require('path');
const join = require('path').join;
var mkdirp = require('mkdirp');

app.use(express.static(path.join(__dirname, 'app')));

//Note when renewing Convert zerossl cert first `openssl.exe rsa -in domain-key.key -out domain-key.key`
// fix error:    App threw an error during load
//               Error: error:06000066:public key routines:OPENSSL_internal:DECODE_ERROR

var httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'privkey1.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fullchain1.pem')),
};

const httpsserver = https.createServer(httpsOptions, app).listen(3001, function () {
  debug_log('https: listening on:' + ip.address() + ':3001');
});

const httpserver = http.listen(config.webPort, '0.0.0.0', function () {
  debug_log('http:  listening on:' + ip.address() + ':' + config.webPort);
});

io.attach(httpserver);
io.attach(httpsserver);

const grblStrings = require('./grblStrings.js');
const serialport = require('serialport');
var SerialPort = serialport;
const Readline = SerialPort.parsers.Readline;
var md5 = require('md5');
var ip = require('ip');
var _ = require('lodash');
var fs = require('fs');
var formidable = require('formidable');
var lastsentuploadprogress = 0;

// Electron app
const electron = require('electron');
const electronApp = electron.app;

if (isElectron()) {
  debug_log('Local User Data: ' + electronApp.getPath('userData'));
  electronApp.commandLine.appendSwitch('ignore-gpu-blacklist', 'true');
  electronApp.commandLine.appendSwitch('enable-gpu-rasterization', 'true');
  electronApp.commandLine.appendSwitch('enable-zero-copy', 'true');
  electronApp.commandLine.appendSwitch('disable-software-rasterizer', 'true');
  electronApp.commandLine.appendSwitch('enable-native-gpu-memory-buffers', 'true');
  // Removing max-old-space-size switch (Introduced in 1.0.168 and removed in 1.0.169) due it causing High CPU load on some PCs.
  //electronApp.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')
  debug_log('Command Line Arguments for Electron: Set OK');
}
const BrowserWindow = electron.BrowserWindow;
const Tray = electron.Tray;
const nativeImage = require('electron').nativeImage;
const Menu = require('electron').Menu;
var forceQuit;

var appIcon = null,
  jogWindow = null,
  mainWindow = null;
var autoUpdater;

var updateIsDownloading = false;
if (isElectron()) {
  autoUpdater = require('electron-updater').autoUpdater;
  var availversion = '0.0.0';

  autoUpdater.on('checking-for-update', () => {
    var string = 'Starting update... Please wait';
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
  });
  autoUpdater.on('update-available', (ev, info) => {
    updateIsDownloading = true;
    var string = 'Starting Download: v' + ev.version;
    availversion = ev.version;
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
    debug_log(JSON.stringify(ev));
  });
  autoUpdater.on('update-not-available', (ev, info) => {
    var string =
      'Update not available. Installed version: ' + require('./package').version + ' / Available version: ' + ev.version + '.\n';
    if (require('./package').version === ev.version) {
      string += 'You are already running the latest version!';
    }
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
    debug_log(JSON.stringify(ev));
  });
  autoUpdater.on('error', (ev, err) => {
    if (err) {
      var string = 'Error in auto-updater: \n' + err.split('SyntaxError')[0];
    } else {
      var string = 'Error in auto-updater';
    }
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
  });
  autoUpdater.on('download-progress', (ev, progressObj) => {
    updateIsDownloading = true;
    var string = 'Download update ... ' + ev.percent.toFixed(1) + '%';
    debug_log(string);
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
    io.sockets.emit('updateprogress', ev.percent.toFixed(0));
  });

  autoUpdater.on('update-downloaded', (info) => {
    var string = 'New update ready';
    var output = {
      command: 'autoupdate',
      response: string,
    };
    io.sockets.emit('updatedata', output);
    io.sockets.emit('updateready', availversion);
    // repeat every minute
    setTimeout(function () {
      io.sockets.emit('updateready', availversion);
    }, 60 * 60 * 1000); // 60 mins
    updateIsDownloading = false;
  });
} else {
  debug_log('Running outside Electron: Disabled AutoUpdater');
}

if (isElectron()) {
  var uploadsDir = electronApp.getPath('userData') + '/upload/';
} else {
  var uploadsDir =
    process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : '/var/local');
}
var jobCompletedMsg = ''; // message sent when job is done
var uploadedgcode = ''; // var to store uploaded gcode
var uploadedworkspace = ''; // var to store uploaded OpenBuildsCAM Workspace

mkdirp(uploadsDir).then((made) => debug_log('Created Uploads Temp Directory'));

// Check USB Selective Suspend Settings
function checkPowerSettings() {
  if (process.platform == 'win32') {
    debug_log('Checking Power Settings');
    var powerplan = '',
      usbselectiveAC = false,
      usbselectiveDC = false;
    const { exec } = require('child_process');

    const cfg = exec('powercfg /GETACTIVESCHEME', function (error, stdout, stderr) {
      if (error) {
        debug_log(error.stack);
        debug_log('Error code: ' + error.code);
        debug_log('Signal received: ' + error.signal);
      }
      // console.log('Child Process STDOUT: ' + stdout);
      // console.log('Child Process STDERR: ' + stderr);
      powerplan = stdout.split(':')[1].split('()')[0].trim();
    });

    cfg.on('exit', function (code) {
      debug_log('powercfg /GETACTIVESCHEME exited with exit code ' + code);
      if (code == 0) {
        const usbsetting = exec('powercfg /q ' + powerplan, function (error, stdout, stderr) {
          if (error) {
            debug_log(error.stack);
            debug_log('Error code: ' + error.code);
            debug_log('Signal received: ' + error.signal);
          }
          // console.log('Child Process STDOUT: ' + stdout);
          // console.log('Child Process STDERR: ' + stderr);
          usbselective = stdout.slice(stdout.search('USB selective suspend setting') - 1).split('\n');
          usbselective.length = 7;

          if (usbselective[5].indexOf('0x00000000') != -1) {
            debug_log('USB Selective Suspend DISABLED on AC power ');
            status.driver.powersettings.usbselectiveAC = false;
          } else if (usbselective[5].indexOf('0x00000001') != -1) {
            debug_log('USB Selective Suspend ENABLED on AC power ');
            status.driver.powersettings.usbselectiveAC = true;
          }

          if (usbselective[6].indexOf('0x00000000') != -1) {
            debug_log('USB Selective Suspend DISABLED on DC power ');
            status.driver.powersettings.usbselectiveDC = false;
          } else if (usbselective[6].indexOf('0x00000001') != -1) {
            debug_log('USB Selective Suspend ENABLED on DC power ');
            status.driver.powersettings.usbselectiveDC = true;
          }
        });
        usbsetting.on('exit', function (code) {
          debug_log('powercfg /q exited with exit code ' + code);
          setTimeout(function () {
            debug_log(status.driver.powersettings.usbselectiveDC, status.driver.powersettings.usbselectiveAC);
          }, 200);
        });
      }
    });
    //  end USB Selective Suspend
  }
}

var oldportslist;
var oldpinslist;
const iconPath = path.join(__dirname, 'app/icon.png');
const iconNoComm = path.join(__dirname, 'app/icon-notconnected.png');
const iconPlay = path.join(__dirname, 'app/icon-play.png');
const iconStop = path.join(__dirname, 'app/icon-stop.png');
const iconPause = path.join(__dirname, 'app/icon-pause.png');
const iconAlarm = path.join(__dirname, 'app/icon-bell.png');

var iosocket;
var lastCommand = false;
var gcodeQueue = [];
var queuePointer = 0;
var statusLoop;
var queueCounter;
var listPortsLoop;

var GRBL_RX_BUFFER_SIZE = 127; // 128 characters
var sentBuffer = [];

var xPos = 0.0;
var yPos = 0.0;
var zPos = 0.0;
var aPos = 0.0;
var xOffset = 0.0;
var yOffset = 0.0;
var zOffset = 0.0;
var aOffset = 0.0;
var has4thAxis = false;

var feedOverride = 100,
  spindleOverride = 100;

//regex to identify MD5hash on sdupload later
var re = new RegExp('^[a-f0-9]{32}');

var status = {
  driver: {
    version: require('./package').version,
    ipaddress: ip.address(),
    operatingsystem: false,
    powersettings: {
      usbselectiveAC: null,
      usbselectiveDC: null,
    },
  },
  machine: {
    name: '',
    inputs: [],
    overrides: {
      feedOverride: 100, //
      spindleOverride: 100, //
      realFeed: 0, //
      realSpindle: 0, //
    },
    //
    tool: {
      nexttool: {
        number: 0,
        line: '',
      },
    },
    probe: {
      x: 0.0,
      y: 0.0,
      z: 0.0,
      state: -1,
      plate: 0.0,
      request: {},
    },
    position: {
      work: {
        x: 0,
        y: 0,
        z: 0,
        a: 0,
        e: 0,
      },
      offset: {
        x: 0,
        y: 0,
        z: 0,
        a: 0,
        e: 0,
      },
    },
    firmware: {
      type: '',
      version: '',
      date: '',
      buffer: [],
      features: [],
      blockBufferSize: '',
      rxBufferSize: '',
    },
  },
  comms: {
    connectionStatus: 0, //0 = not connected, 1 = opening, 2 = connected, 3 = playing, 4 = paused, 5 = alarm, 6 = firmware upgrade
    connectionStatusPendant: 0, //0 = not connected, 1 = opening, 2 = connected, 3 = error
    runStatus: 'Pending', // 0 = init, 1 = idle, 2 = alarm, 3 = stop, 4 = run, etc?
    queue: 0,
    blocked: false,
    paused: false,
    controllerBuffer: 0, // Seems like you are tracking available buffer?  Maybe nice to have in frontend?
    interfaces: {
      ports: '',
      activePort: '', // or activeIP in the case of wifi/telnet?
      activePortPendant: '',
    },
    alarm: '',
  },
};

async function findPorts() {
  const ports = await SerialPort.list();
  // console.log(ports)
  oldportslist = ports;
  status.comms.interfaces.ports = ports;
  for (const port of ports) {
  }
  // throw new Error('No ports found')
}
findPorts();

async function findChangedPorts() {
  const ports = await SerialPort.list();
  // console.log(ports)
  status.comms.interfaces.ports = ports;
  if (!_.isEqual(ports, oldportslist)) {
    var newPorts = _.differenceWith(ports, oldportslist, _.isEqual);
    if (newPorts.length > 0) {
      debug_log('Plugged ' + newPorts[0].path);
    }
    var removedPorts = _.differenceWith(oldportslist, ports, _.isEqual);
    if (removedPorts.length > 0) {
      debug_log('Unplugged ' + removedPorts[0].path);
    }
  }
  oldportslist = ports;
  // throw new Error('No ports found')
}
findPorts();

// SerialPort.list(function(err, ports) {
//   oldportslist = ports;
//   status.comms.interfaces.ports = ports;
// });

var PortCheckinterval = setInterval(function () {
  if (status.comms.connectionStatus == 0) {
    findChangedPorts();
  }
}, 500);

checkPowerSettings();
var PowerSettingsInterval = setInterval(function () {
  checkPowerSettings();
}, 60 * 1000);

// JSON API
app.get('/api/version', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  data = {
    application: 'OMD',
    version: require('./package').version,
    ipaddress: ip.address() + ':' + config.webPort,
  };
  res.send(JSON.stringify(data), null, 2);
});

app.get('/activate', (req, res) => {
  debug_log(req.hostname);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.send('Host: ' + req.hostname + ' asked to activate OpenBuilds CONTROL v' + require('./package').version);
  if (jogWindow === null) {
    createJogWindow();
    jogWindow.show();
    // workaround from https://github.com/electron/electron/issues/2867#issuecomment-261067169 to make window pop over for focus
    jogWindow.setAlwaysOnTop(true);
    jogWindow.focus();
    jogWindow.setAlwaysOnTop(false);
  } else {
    jogWindow.show();
    jogWindow.setAlwaysOnTop(true);
    jogWindow.focus();
    jogWindow.setAlwaysOnTop(false);
  }
  setTimeout(function () {
    io.sockets.emit('activate', req.hostname);
  }, 1500);
});

// Upload
app.get('/upload', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.sendFile(__dirname + '/app/upload.html');
});

app.get('/gcode', (req, res) => {
  if (uploadedgcode.indexOf('$') != 0) {
    // Ignore grblSettings jobs
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.send(uploadedgcode);
  }
});

app.get('/workspace', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.send(uploadedworkspace);
});

// File Post
app.post('/upload', function (req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  //debug_log(req)
  uploadprogress = 0;
  var form = new formidable.IncomingForm();
  form.parse(req, function (err, fields, files) {
    // debug_log(files);
  });

  form.on('fileBegin', function (name, file) {
    debug_log('Uploading ' + file.name);
    file.path = uploadsDir + file.name;
  });

  form.on('progress', function (bytesReceived, bytesExpected) {
    uploadprogress = parseInt(((bytesReceived * 100) / bytesExpected).toFixed(0));
    if (uploadprogress != lastsentuploadprogress) {
      lastsentuploadprogress = uploadprogress;
    }
  });

  form.on('file', function (name, file) {
    debug_log('Uploaded ' + file.path);

    if (jogWindow === null) {
      createJogWindow();
      jogWindow.show();
      // workaround from https://github.com/electron/electron/issues/2867#issuecomment-261067169 to make window pop over for focus
      jogWindow.setAlwaysOnTop(true);
      jogWindow.focus();
      jogWindow.setAlwaysOnTop(false);
    } else {
      jogWindow.show();
      jogWindow.setAlwaysOnTop(true);
      jogWindow.focus();
      jogWindow.setAlwaysOnTop(false);
    }
    readFile(file.path);
  });

  form.on('aborted', function () {
    // Emitted when the request was aborted by the user. Right now this can be due to a 'timeout' or 'close' event on the socket. After this event is emitted, an error event will follow. In the future there will be a separate 'timeout' event (needs a change in the node core).
  });

  form.on('end', function () {
    //Emitted when the entire request has been received, and all contained files have finished flushing to disk. This is a great place for you to send your response.
  });

  res.sendFile(__dirname + '/app/upload.html');
});

app.on('certificate-error', function (event, webContents, url, error, certificate, callback) {
  event.preventDefault();
  callback(true);
});

io.on('connection', function (socket) {
  iosocket = socket;

  if (status.machine.firmware.type == 'grbl') {
    // handle Grbl RESET external input
    if (status.machine.inputs.length > 0) {
      for (i = 0; i < status.machine.inputs.length; i++) {
        switch (status.machine.inputs[i]) {
          case 'R':
            // debug_log('PIN: SOFTRESET');
            safetosend = true;
            break;
        }
      }
    } else {
      io.sockets.emit('grbl');
    }
    if (safetosend != undefined && safetosend == true) {
      io.sockets.emit('grbl');
    }
  }

  var interval = setInterval(function () {
    io.sockets.emit('status', status);
    // v1.0.210 - testing if this caused hangs
    // if (jogWindow) {
    //   if (status.comms.connectionStatus == 0) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconNoComm), 'Not Connected');
    //   } else if (status.comms.connectionStatus == 1) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconStop), 'Port Connected');
    //   } else if (status.comms.connectionStatus == 2) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconStop), 'Connected, and Firmware');
    //   } else if (status.comms.connectionStatus == 3) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconPlay), 'Playing');
    //   } else if (status.comms.connectionStatus == 4) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconPause), 'Paused');
    //   } else if (status.comms.connectionStatus == 5) {
    //     jogWindow.setOverlayIcon(nativeImage.createFromPath(iconAlarm), 'Alarm');
    //   }
    // }
  }, 400);

  socket.on('openbuilds', function (data) {
    const { shell } = require('electron');
    shell.openExternal('https://www.openbuilds.com');
  });

  socket.on('opencam', function (data) {
    const { shell } = require('electron');
    shell.openExternal('https://cam.openbuilds.com');
  });

  socket.on('openforum', function (data) {
    const { shell } = require('electron');
    shell.openExternal('https://openbuilds.com/threads/openbuilds-control-software.13121/');
  });

  socket.on('opendriverspage', function (data) {
    const { shell } = require('electron');
    shell.openExternal('https://docs.openbuilds.com/blackbox/#41-devicedrivers.html');
  });

  socket.on('minimisetotray', function (data) {
    jogWindow.hide();
  });

  socket.on('minimize', function (data) {
    jogWindow.minimize();
  });

  socket.on('maximize', function (data) {
    jogWindow.maximize();
  });

  socket.on('quit', function (data) {
    if (appIcon) {
      appIcon.destroy();
    }
    electronApp.exit(0);
  });

  socket.on('applyUpdate', function (data) {
    autoUpdater.quitAndInstall();
  });

  socket.on('downloadUpdate', function (data) {
    if (!updateIsDownloading) {
      if (typeof autoUpdater !== 'undefined') {
        autoUpdater.checkForUpdates();
      } else {
        debug_log('autoUpdater not found');
      }
    }
  });

  socket.on('flashGrbl', function (data) {
    var port = data.port;
    var file = data.file;
    var board = data.board;
    const Avrgirl = require('avrgirl-arduino');

    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }

    function flashGrblCallback(debugString, port) {
      debug_log(port, debugString);
      var data = {
        port: port,
        string: debugString,
      };
      io.sockets.emit('progStatus', data);
    }

    setTimeout(function () {
      var avrgirl = new Avrgirl({
        board: board,
        port: port,
        debug: function (debugString) {
          var port = this.connection.options.port;
          flashGrblCallback(debugString, port);
        },
      });

      debug_log(JSON.stringify(avrgirl));

      status.comms.connectionStatus = 6;
      avrgirl.flash(path.join(__dirname, file), function (error) {
        if (error) {
          console.error(error);
          io.sockets.emit('progStatus', 'Flashing FAILED!');
          status.comms.connectionStatus = 0;
        } else {
          console.info('done.');
          io.sockets.emit('progStatus', 'Programmed Succesfully');
          io.sockets.emit('progStatus', 'Please Reconnect');
          status.comms.connectionStatus = 0;
        }
        status.comms.connectionStatus = 0;
      });
    }, 1000);
  });

  socket.on('connectTo', function (data) {
    // If a user picks a port to connect to, open a Node SerialPort Instance to it

    if (status.comms.connectionStatus < 1) {
      data = data.split(',');
      console.log('Connecting via ' + data[0] + ' to ' + data[1] + ' at baud ' + data[2]);

      port = new SerialPort(data[1], {
        baudRate: parseInt(data[2]),
      });

      parser = port.pipe(
        new Readline({
          delimiter: '\r\n',
        })
      );

      // port.on("data", function(data) {
      //   console.log(data)
      // })

      port.on('error', function (err) {
        if (err.message != 'Port is not open') {
          debug_log('Error: ', err.message);
          var output = {
            command: '',
            response: 'PORT ERROR: ' + err.message,
          };
          io.sockets.emit('data', output);

          if (status.comms.connectionStatus > 0) {
            debug_log('WARN: Closing Port ' + port.path);
            status.comms.connectionStatus = 0;
            stopPort();
          } else {
            debug_log('ERROR: Machine connection not open!');
          }
        }
      });

      port.on('open', function () {
        debug_log('PORT INFO: Connected to ' + port.path + ' at ' + port.baudRate);
        var output = {
          command: 'connect',
          response: 'PORT INFO: Port is now open: ' + port.path + ' - Attempting to detect Firmware',
        };
        io.sockets.emit('data', output);

        status.comms.connectionStatus = 1;

        var output = {
          command: 'connect',
          response: 'Checking for firmware on ' + port.path,
        };
        io.sockets.emit('data', output);
        addQRealtime('\n'); // this causes smoothie to send the welcome string

        var output = {
          command: 'connect',
          response: 'Detecting Firmware: Method 1 (Autoreset)',
        };
        io.sockets.emit('data', output);

        setTimeout(function () {
          //wait for controller to be ready
          if (status.machine.firmware.type.length < 1) {
            debug_log(
              'Didnt detect firmware after AutoReset. Lets see if we have Grbl instance with a board that doesnt have AutoReset'
            );
            var output = {
              command: 'connect',
              response: 'Detecting Firmware: Method 2 (Ctrl+X)',
            };
            io.sockets.emit('data', output);
            addQRealtime(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
            debug_log('Sent: Ctrl+x');
          }
        }, config.grblWaitTime * 1000);

        setTimeout(function () {
          //wait for controller to be ready
          if (status.machine.firmware.type.length < 1) {
            debug_log('No firmware yet, probably not Grbl then. lets see if we have Smoothie?');
            var output = {
              command: 'connect',
              response: 'Detecting Firmware: Method 3 (others that are not supported)',
            };
            io.sockets.emit('data', output);
            addQRealtime('version\n'); // Check if it's Smoothieware?
            debug_log('Sent: version');
          }
        }, config.grblWaitTime * 2000);

        if (config.firmwareWaitTime > 0) {
          setTimeout(function () {
            // Close port if we don't detect supported firmware after 2s.
            if (status.machine.firmware.type.length < 1) {
              debug_log('No supported firmware detected. Closing port ' + port.path);
              var output = {
                command: 'connect',
                response:
                  'ERROR!:  No supported firmware detected - you need a controller with Grbl 1.1x on it, or there is a problem with your controller. Closing port ' +
                  port.path,
              };
              io.sockets.emit('data', output);
              stopPort();
            } else {
              var output = {
                command: 'connect',
                response:
                  'Firmware Detected:  ' +
                  status.machine.firmware.type +
                  ' version ' +
                  status.machine.firmware.version +
                  ' on ' +
                  port.path,
              };
              io.sockets.emit('data', output);
            }
          }, config.firmwareWaitTime * 1000);
        }

        status.comms.connectionStatus = 2;
        status.comms.interfaces.activePort = port.path;
        status.comms.interfaces.activeBaud = port.baudRate;
      }); // end port .onopen

      port.on('close', function () {
        // open errors will be emitted as an error event
        debug_log('PORT INFO: Port closed');
        var output = {
          command: 'disconnect',
          response: 'PORT INFO: Port closed',
        };
        io.sockets.emit('data', output);
        status.comms.connectionStatus = 0;
      }); // end port.onclose

      parser.on('data', function (data) {
        // console.log(data)
        var command = sentBuffer[0];

        if (data.indexOf('<') != 0) {
          debug_log('data:', data);
        }

        // Grbl $I parser
        if (data.indexOf('[VER:') === 0) {
          status.machine.name = data.split(':')[2].split(']')[0].toLowerCase();
          io.sockets.emit('status', status);
          io.sockets.emit('machinename', data.split(':')[2].split(']')[0].toLowerCase());
        }

        if (data.indexOf('[OPT:') === 0) {
          var startOpt = data.search(/opt:/i) + 4;
          var grblOpt;
          if (startOpt > 4) {
            var grblOptLen = data.substr(startOpt).search(/]/);
            grblOpts = data.substr(startOpt, grblOptLen).split(/,/);

            status.machine.firmware.blockBufferSize = grblOpts[1];
            status.machine.firmware.rxBufferSize = grblOpts[2];

            var features = [];

            var i = grblOpts[0].length;
            while (i--) {
              features.push(grblOpts[0].charAt(i));
              switch (grblOpts[0].charAt(i)) {
                case 'Q':
                  debug_log('SPINDLE_IS_SERVO Enabled');
                  //
                  break;
                case 'V': //	Variable spindle enabled
                  debug_log('Variable spindle enabled');
                  //
                  break;
                case 'N': //	Line numbers enabled
                  debug_log('Line numbers enabled');
                  //
                  break;
                case 'M': //	Mist coolant enabled
                  debug_log('Mist coolant enabled');
                  //
                  break;
                case 'C': //	CoreXY enabled
                  debug_log('CoreXY enabled');
                  //
                  break;
                case 'P': //	Parking motion enabled
                  debug_log('Parking motion enabled');
                  //
                  break;
                case 'Z': //	Homing force origin enabled
                  debug_log('Homing force origin enabled');
                  //
                  break;
                case 'H': //	Homing single axis enabled
                  debug_log('Homing single axis enabled');
                  //
                  break;
                case 'T': //	Two limit switches on axis enabled
                  debug_log('Two limit switches on axis enabled');
                  //
                  break;
                case 'A': //	Allow feed rate overrides in probe cycles
                  debug_log('Allow feed rate overrides in probe cycles');
                  //
                  break;
                case '$': //	Restore EEPROM $ settings disabled
                  debug_log('Restore EEPROM $ settings disabled');
                  //
                  break;
                case '#': //	Restore EEPROM parameter data disabled
                  debug_log('Restore EEPROM parameter data disabled');
                  //
                  break;
                case 'I': //	Build info write user string disabled
                  debug_log('Build info write user string disabled');
                  //
                  break;
                case 'E': //	Force sync upon EEPROM write disabled
                  debug_log('Force sync upon EEPROM write disabled');
                  //
                  break;
                case 'W': //	Force sync upon work coordinate offset change disabled
                  debug_log('Force sync upon work coordinate offset change disabled');
                  //
                  break;
                case 'L': //	Homing init lock sets Grbl into an alarm state upon power up
                  debug_log('Homing init lock sets Grbl into an alarm state upon power up');
                  //
                  break;
              }
            }
            status.machine.firmware.features = features;
            io.sockets.emit('features', features);
          }
        }

        // [PRB:0.000,0.000,0.000:0]
        if (data.indexOf('[PRB:') === 0) {
          if (status.machine.probe.request.plate) {
            debug_log(data);
            var prbLen = data.substr(5).search(/\]/);
            var prbData = data.substr(5, prbLen).split(/,/);
            var success = data.split(':')[2].split(']')[0];
            status.machine.probe.x = prbData[0];
            status.machine.probe.y = prbData[1];
            status.machine.probe.z = prbData[2];
            status.machine.probe.state = success;
            if (success > 0) {
              var output = {
                command: '[ PROBE ]',
                response: 'Probe Completed.  Setting Z to ' + status.machine.probe.plate + 'mm',
              };
              io.sockets.emit('data', output);
              addQToEnd('G10 P1 L20 Z' + status.machine.probe.plate);
              send1Q();
            } else {
              var output = {
                command: '[ PROBE ]',
                response: 'Probe move aborted - probe did not make contact within specified distance',
              };
              io.sockets.emit('data', output);
            }
            io.sockets.emit('prbResult', status);
            status.machine.probe.request = '';
          }
        }

        // Machine Identification
        if (data.indexOf('Grbl') === 0) {
          // Check if it's Grbl
          debug_log(data);
          status.comms.blocked = false;
          status.machine.firmware.type = 'grbl';
          status.machine.firmware.version = data.substr(5, 4); // get version
          if (parseFloat(status.machine.firmware.version) < 1.1) {
            // If version is too old
            if (status.machine.firmware.version.length < 3) {
              debug_log('invalid version string, stay connected');
            } else {
              if (status.comms.connectionStatus > 0) {
                debug_log('WARN: Closing Port ' + port.path + ' /  v' + parseFloat(status.machine.firmware.version));
                // stopPort();
              } else {
                debug_log('ERROR: Machine connection not open!');
              }
              var output = {
                command: command,
                response:
                  'Detected an unsupported version: Grbl ' +
                  status.machine.firmware.version +
                  '. This is sadly outdated. Please upgrade to Grbl 1.1 or newer to use this software.  Go to http://github.com/gnea/grbl',
              };
              io.sockets.emit('data', output);
            }
          }
          status.machine.firmware.date = '';
          debug_log('GRBL detected');
          setTimeout(function () {
            io.sockets.emit('grbl');
          }, 600);
          // Start interval for status queries
          statusLoop = setInterval(function () {
            if (status.comms.connectionStatus > 0) {
              addQRealtime('?');
            }
          }, 250);
        } else if (data.indexOf('LPC176') >= 0) {
          // LPC1768 or LPC1769 should be Smoothieware
          status.comms.blocked = false;
          debug_log('Smoothieware detected');
          status.machine.firmware.type = 'smoothie';
          status.machine.firmware.version = data.substr(data.search(/version:/i) + 9).split(/,/);
          status.machine.firmware.date = new Date(data.substr(data.search(/Build date:/i) + 12).split(/,/)).toDateString();
          // Start interval for status queries
          // statusLoop = setInterval(function() {
          //   if (status.comms.connectionStatus > 0) {
          //     addQRealtime("?");
          //   }
          // }, 200);
          var output = {
            command: 'FIRMWARE ERROR',
            response:
              'Detected an unsupported version: Smoothieware ' +
              status.machine.firmware.version +
              '. This software no longer support Smoothieware. \nLuckilly there is an alternative firmware you can install on your controller to make it work with this software. Check out Grbl-LPC at https://github.com/cprezzi/grbl-LPC - Grbl-LPC is a Grbl port for controllers using the NXP LPC176x chips, for example Smoothieboards',
          };
          io.sockets.emit('data', output);
          stopPort();
        } // end of machine identification

        // Machine Feedback: Position
        if (data.indexOf('<') === 0) {
          // debug_log(' Got statusReport (Grbl & Smoothieware)')
          // statusfeedback func
          parseFeedback(data);
          // debug_log(data)
        } else if (data.indexOf('ok') === 0) {
          // Got an OK so we are clear to send
          // debug_log("OK FOUND")
          if (status.machine.firmware.type === 'grbl') {
            // debug_log('got OK from ' + command)
            command = sentBuffer.shift();
          }
          status.comms.blocked = false;
          send1Q();
        } else if (data.indexOf('ALARM') === 0) {
          //} || data.indexOf('HALTED') === 0) {
          debug_log('ALARM:  ' + data);
          status.comms.connectionStatus = 5;
          switch (status.machine.firmware.type) {
            case 'grbl':
              // sentBuffer.shift();
              var alarmCode = parseInt(data.split(':')[1]);
              debug_log('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
              status.comms.alarm = alarmCode + ' - ' + grblStrings.alarms(alarmCode);
              if (alarmCode != 5) {
                io.sockets.emit(
                  'toastErrorAlarm',
                  'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode) + ' [ ' + command + ' ]'
                );
              }
              var output = {
                command: '',
                response: 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode) + ' [ ' + command + ' ]',
              };
              io.sockets.emit('data', output);
              break;
          }
          status.comms.connectionStatus = 5;
        } else if (data.indexOf('WARNING: After HALT you should HOME as position is currently unknown') != -1) {
          //} || data.indexOf('HALTED') === 0) {
          status.comms.connectionStatus = 2;
        } else if (data.indexOf('Emergency Stop Requested') != -1) {
          //} || data.indexOf('HALTED') === 0) {
          debug_log('Emergency Stop Requested');
          status.comms.connectionStatus = 5;
        } else if (data.indexOf('wait') === 0) {
          // Got wait from Repetier -> ignore
          // do nothing
        } else if (data.indexOf('error') === 0) {
          // Error received -> stay blocked stops queue
          switch (status.machine.firmware.type) {
            case 'grbl':
              // sentBuffer.shift();
              var errorCode = parseInt(data.split(':')[1]);
              debug_log('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + ' [ ' + command + ' ]');
              var output = {
                command: '',
                response: 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + ' [ ' + command + ' ]',
              };
              io.sockets.emit('data', output);
              io.sockets.emit(
                'toastError',
                'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + ' [ ' + command + ' ]'
              );
              break;
          }
          debug_log('error;');
          sentBuffer.shift();
          status.comms.connectionStatus = 5;
        } else if (data === ' ') {
          // nothing
        } else {
          // do nothing with +data
        }

        if (data.indexOf('[MSG:Reset to continue]') === 0) {
          switch (status.machine.firmware.type) {
            case 'grbl':
              debug_log('[MSG:Reset to continue] -> Sending Reset');
              addQRealtime(String.fromCharCode(0x18)); // ctrl-x
              break;
          }
        }

        if (command) {
          command = command.replace(/(\r\n|\n|\r)/gm, '');
          // debug_log("CMD: " + command + " / DATA RECV: " + data.replace(/(\r\n|\n|\r)/gm, ""));

          if (command != '?' && command != 'M105' && data.length > 0 && data.indexOf('<') == -1) {
            var string = '';
            if (status.comms.sduploading) {
              string += 'SD: ';
            }
            string += data; //+ "  [ " + command + " ]"
            var output = {
              command: command,
              response: string,
            };
            // debug_log(output.response)
            io.sockets.emit('data', output);
          }
        } else {
          if (data.indexOf('<') != 0) {
            var output = {
              command: '',
              response: data,
            };
            io.sockets.emit('data', output);
          }
        }
      }); // end of parser.on(data)
    }
  });

  socket.on('connectToPendant', function (data) {
    // If a user picks a port to connect to, open a Node SerialPort Instance to it
    console.log('Connect To Pendant...', status.comms.connectionStatusPendant);
    if (status.comms.connectionStatusPendant < 1) {
      data = data.split(',');
      console.log('Connecting via ' + data[0] + ' to ' + data[1] + ' at baud ' + data[2]);

      portPendant = new SerialPort(data[1], {
        baudRate: parseInt(data[2]),
      });

      parser = portPendant.pipe(
        new Readline({
          delimiter: '\r\n',
        })
      );

      portPendant.on('error', function (err) {
        if (err.message != 'Pendant port is not open') {
          debug_log('Error: ', err.message);
          var output = {
            command: '',
            response: 'PENDANT PORT ERROR: ' + err.message,
          };
          io.sockets.emit('data', output);

          if (status.comms.connectionStatusPendant > 0) {
            debug_log('WARN: Closing Port ' + port.path);
            status.comms.connectionStatusPendant = 0;
            stopPort();
          } else {
            debug_log('ERROR: Pendant connection not open!');
          }
        }
      });

      portPendant.on('open', function () {
        debug_log('PORT INFO: Pendant connected to ' + portPendant.path + ' at ' + portPendant.baudRate);
        var output = {
          command: 'connect',
          response: 'PORT INFO: Pendant port is now open: ' + portPendant.path,
        };
        io.sockets.emit('data', output);

        status.comms.connectionStatusPendant = 1;

        status.comms.connectionStatusPendant = 2;
        status.comms.interfaces.activePortPendant = portPendant.path;
        status.comms.interfaces.activeBaudPendant = portPendant.baudRate;
      }); // end portPendant .onopen

      portPendant.on('close', function () {
        // open errors will be emitted as an error event
        debug_log('PORT INFO: Pendant port closed');
        var output = {
          command: 'disconnect',
          response: 'PORT INFO: Pendant port closed',
        };
        io.sockets.emit('data', output);
        status.comms.connectionStatusPendant = 0;
      }); // end port.onclose

      parser.on('data', function (data) {
        // console.log('Pendant parser.on', data);
        var command = sentBuffer[0];

        if (data.indexOf('<') != 0) {
          debug_log('data:', data);
        }

        if (data.indexOf('JOG') != 0) {
          // Jog The Machine
        }
      }); // end of parser.on(data)
    }
  });

  socket.on('saveToSd', function (datapack) {
    saveToSd(datapack);
  });

  socket.on('setqueuePointer', function (data) {
    debug_log('Setting queuePointer to ' + data);
    queuePointer = data;
  });

  socket.on('runJob', function (object) {
    // debug_log(data)
    var data = object.data;
    if (object.isJob) {
      uploadedgcode = data;
    }

    if (object.completedMsg) {
      jobCompletedMsg = object.completedMsg;
    }

    // debug_log('Run Job (' + data.length + ')');
    if (status.comms.connectionStatus > 0) {
      if (data) {
        data = data.split('\n');
        for (var i = 0; i < data.length; i++) {
          var line = data[i].replace('%', '').split(';'); // Remove everything after ; = comment
          var tosend = line[0].trim();
          if (tosend.length > 0) {
            addQToEnd(tosend);
          }
        }
        if (i > 0) {
          // Start interval for qCount messages to socket clients
          queueCounter = setInterval(function () {
            status.comms.queue = gcodeQueue.length - queuePointer;
          }, 500);
          send1Q(); // send first line
          status.comms.connectionStatus = 3;
        }
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('forceQueue', function (data) {
    send1Q();
  });

  socket.on('runCommand', function (data) {
    debug_log('Run Command (' + data.replace('\n', '|') + ')');
    if (status.comms.connectionStatus > 0) {
      if (data) {
        data = data.split('\n');
        for (var i = 0; i < data.length; i++) {
          var line = data[i].split(';'); // Remove everything after ; = comment
          var tosend = line[0].trim();
          if (tosend.length > 0) {
            addQToEnd(tosend);
          }
        }
        if (i > 0) {
          status.comms.runStatus = 'Running';
          // debug_log('sending ' + JSON.stringify(gcodeQueue))
          send1Q();
        }
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('zProbe', function (data) {
    debug_log(
      'Probing ' +
        data.direction +
        ' down to ' +
        data.dist +
        'mm at ' +
        data.feedrate +
        'mm/min and then subtracting a plate of ' +
        data.plate +
        'mm'
    );
    status.machine.probe.request = data;
    status.machine.probe.x = 0.0;
    status.machine.probe.y = 0.0;
    status.machine.probe.z = 0.0;
    status.machine.probe.state = -1;
    status.machine.probe.plate = data.plate;
    switch (status.machine.firmware.type) {
      case 'grbl':
        addQToEnd('G21');
        addQToEnd('G10 P1 L20 Z0');
        addQToEnd('G38.2 Z-' + data.dist + ' F' + data.feedrate);
        send1Q();
        break;
        debug_log('ERROR: Unsupported firmware!');
        break;
      default:
        debug_log('ERROR: Unsupported firmware!');
        break;
    }
  });

  socket.on('jog', function (data) {
    debug_log('Jog ' + data);
    if (status.comms.connectionStatus > 0) {
      data = data.split(',');
      var dir = data[0];
      var dist = parseFloat(data[1]);
      var feed;
      if (data.length > 2) {
        feed = parseInt(data[2]);
        if (feed) {
          feed = 'F' + feed;
        }
      }
      if (dir && dist && feed) {
        debug_log(
          'Adding jog commands to queue. Firmw=' +
            status.machine.firmware.type +
            ', blocked=' +
            status.comms.blocked +
            ', paused=' +
            status.comms.paused +
            ', Q=' +
            gcodeQueue.length
        );
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21' + dir + dist + feed);
            send1Q();
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('ERROR: Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('jogXY', function (data) {
    debug_log('Jog XY' + data);
    if (status.comms.connectionStatus > 0) {
      // var data = {
      //   x: xincrement,
      //   y: yincrement,
      //   feed: feed
      // }
      var xincrement = parseFloat(data.x);
      var yincrement = parseFloat(data.y);
      var feed = parseFloat(data.feed);
      if (feed) {
        feed = 'F' + feed;
      }

      if (xincrement && yincrement && feed) {
        debug_log(
          'Adding jog commands to queue. blocked=' +
            status.comms.blocked +
            ', paused=' +
            status.comms.paused +
            ', Q=' +
            gcodeQueue.length
        );
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21X' + xincrement + ' Y' + yincrement + ' ' + feed);
            send1Q();
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('ERROR: Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('jogTo', function (data) {
    // data = {x:xVal, y:yVal, z:zVal, mode:0(absulute)|1(relative), feed:fVal}
    debug_log('JogTo ' + JSON.stringify(data));
    if (status.comms.connectionStatus > 0) {
      if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
        var xVal = data.x !== undefined ? 'X' + parseFloat(data.x) : '';
        var yVal = data.y !== undefined ? 'Y' + parseFloat(data.y) : '';
        var zVal = data.z !== undefined ? 'Z' + parseFloat(data.z) : '';
        var mode = data.mode == 0 ? 0 : 1;
        var feed = data.feed !== undefined ? 'F' + parseInt(data.feed) : '';
        debug_log(
          'Adding jog commands to queue. blocked=' +
            status.comms.blocked +
            ', paused=' +
            status.comms.paused +
            ', Q=' +
            gcodeQueue.length
        );
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21' + mode + xVal + yVal + zVal + feed);
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('error Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('setZero', function (data) {
    debug_log('setZero(' + data + ')');
    if (status.comms.connectionStatus > 0) {
      switch (data) {
        case 'x':
          addQToEnd('G10 L20 P0 X0');
          break;
        case 'y':
          addQToEnd('G10 L20 P0 Y0');
          break;
        case 'z':
          addQToEnd('G10 L20 P0 Z0');
          break;
        case 'a':
          addQToEnd('G10 L20 P0 A0');
          break;
        case 'all':
          addQToEnd('G10 L20 P0 X0 Y0 Z0');
          break;
        case 'xyza':
          addQToEnd('G10 L20 P0 X0 Y0 Z0 A0');
          break;
      }
      send1Q();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('gotoZero', function (data) {
    debug_log('gotoZero(' + data + ')');
    if (status.comms.connectionStatus > 0) {
      switch (data) {
        case 'x':
          addQToEnd('G0 X0');
          break;
        case 'y':
          addQToEnd('G0 Y0');
          break;
        case 'z':
          addQToEnd('G0 Z0');
          break;
        case 'a':
          addQToEnd('G0 A0');
          break;
        case 'all':
          addQToEnd('G0 X0 Y0 Z0');
          break;
        case 'xyza':
          addQToEnd('G0 X0 Y0 Z0 A0');
          break;
      }
      send1Q();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('setPosition', function (data) {
    debug_log('setPosition(' + JSON.stringify(data) + ')');
    if (status.comms.connectionStatus > 0) {
      if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
        var xVal = data.x !== undefined ? 'X' + parseFloat(data.x) + ' ' : '';
        var yVal = data.y !== undefined ? 'Y' + parseFloat(data.y) + ' ' : '';
        var zVal = data.z !== undefined ? 'Z' + parseFloat(data.z) + ' ' : '';
        var aVal = data.a !== undefined ? 'A' + parseFloat(data.a) + ' ' : '';
        addQToEnd('G10 L20 P0 ' + xVal + yVal + zVal + aVal);
        send1Q();
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('probe', function (data) {
    debug_log('probe(' + JSON.stringify(data) + ')');
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          addQToEnd('G38.2 ' + data.direction + '-5 F1');
          addQToEnd('G92 ' + data.direction + ' ' + data.probeOffset);
          send1Q();
          break;
        default:
          //not supported
          debug_log('Command not supported by firmware!');
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('feedOverride', function (data) {
    debug_log(data);
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          debug_log('current FRO = ' + status.machine.overrides.feedOverride);
          debug_log('requested FRO = ' + data);
          var curfro = parseInt(status.machine.overrides.feedOverride);
          var reqfro = parseInt(data);
          var delta;

          if (reqfro == 100) {
            addQRealtime(String.fromCharCode(0x90));
          } else if (curfro < reqfro) {
            // FRO Increase
            delta = reqfro - curfro;
            debug_log('delta = ' + delta);
            var tens = Math.floor(delta / 10);

            debug_log('need to send ' + tens + ' x10s increase');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x91));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x91));
                addQRealtime('?');
              }, i * 50);
            }

            var ones = delta - 10 * tens;
            debug_log('need to send ' + ones + ' x1s increase');
            // for (i = 0; i < ones; i++) {
            //   addQRealtime(String.fromCharCode(0x93));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x93));
                addQRealtime('?');
              }, i * 50);
            }
          } else if (curfro > reqfro) {
            // FRO Decrease
            delta = curfro - reqfro;
            debug_log('delta = ' + delta);

            var tens = Math.floor(delta / 10);
            debug_log('need to send ' + tens + ' x10s decrease');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x92));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x92));
                addQRealtime('?');
              }, i * 50);
            }

            var ones = delta - 10 * tens;
            debug_log('need to send ' + ones + ' x1s decrease');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x94));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x94));
                addQRealtime('?');
              }, i * 50);
            }
          }
          addQRealtime('?');
          status.machine.overrides.feedOverride = parseInt(reqfro); // Set now, but will be overriden from feedback from Grbl itself in next queryloop
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('spindleOverride', function (data) {
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          debug_log('current SRO = ' + status.machine.overrides.spindleOverride);
          debug_log('requested SRO = ' + data);
          var cursro = parseInt(status.machine.overrides.spindleOverride);
          var reqsro = parseInt(data);
          var delta;

          if (reqsro == 100) {
            addQRealtime(String.fromCharCode(153));
          } else if (cursro < reqsro) {
            // FRO Increase
            delta = reqsro - cursro;
            debug_log('delta = ' + delta);
            var tens = Math.floor(delta / 10);

            debug_log('need to send ' + tens + ' x10s increase');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(154));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(154));
                addQRealtime('?');
              }, i * 50);
            }

            var ones = delta - 10 * tens;
            debug_log('need to send ' + ones + ' x1s increase');
            // for (i = 0; i < ones; i++) {
            //   addQRealtime(String.fromCharCode(156));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(156));
                addQRealtime('?');
              }, i * 50);
            }
          } else if (cursro > reqsro) {
            // FRO Decrease
            delta = cursro - reqsro;
            debug_log('delta = ' + delta);

            var tens = Math.floor(delta / 10);
            debug_log('need to send ' + tens + ' x10s decrease');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(155));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(155));
                addQRealtime('?');
              }, i * 50);
            }

            var ones = delta - 10 * tens;
            debug_log('need to send ' + ones + ' x1s decrease');
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(157));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(157));
                addQRealtime('?');
              }, i * 50);
            }
          }
          addQRealtime('?');
          status.machine.overrides.spindleOverride = parseInt(reqsro); // Set now, but will be overriden from feedback from Grbl itself in next queryloop
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('laserTest', function (data) {
    // Laser Test Fire
    laserTest(data);
  });

  socket.on('pause', function () {
    pause();
  });

  socket.on('resume', function () {
    unpause();
  });

  socket.on('stop', function (data) {
    stop(data);
  });

  socket.on('clearAlarm', function (data) {
    // Clear Alarm
    if (status.comms.connectionStatus > 0) {
      data = parseInt(data);
      debug_log('Clearing Queue: Method ' + data);
      switch (data) {
        case 1:
          debug_log('Clearing Lockout');
          switch (status.machine.firmware.type) {
            case 'grbl':
              addQRealtime('$X\n');
              debug_log('Sent: $X');
              break;
          }
          debug_log('Resuming Queue Lockout');
          break;
        case 2:
          debug_log('Emptying Queue');
          status.comms.queue = 0;
          queuePointer = 0;
          gcodeQueue.length = 0; // Dump the queue
          sentBuffer.length = 0; // Dump bufferSizes
          queuePointer = 0;
          debug_log('Clearing Lockout');
          switch (status.machine.firmware.type) {
            case 'grbl':
              addQRealtime(String.fromCharCode(0x18)); // ctrl-x
              addQRealtime('$X\n');
              debug_log('Sent: $X');
              status.comms.blocked = false;
              status.comms.paused = false;
              break;
          }
          break;
      }
      status.comms.runStatus = 'Stopped';
      status.comms.connectionStatus = 2;
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('resetMachine', function () {
    if (status.comms.connectionStatus > 0) {
      debug_log('Reset Machine');
      switch (status.machine.firmware.type) {
        case 'grbl':
          addQRealtime(String.fromCharCode(0x18)); // ctrl-x
          debug_log('Sent: Code(0x18)');
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('closePort', function (data) {
    // Close machine port and dump queue
    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port.path);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('closePortPendant', function (data) {
    // Close machine port and dump queue
    if (status.comms.connectionStatusPendant > 0) {
      debug_log('WARN: Closing Pendant Port ' + portPendant.path);
      stopPortPendant();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });
});

function readFile(path) {
  if (path) {
    if (path.length > 1) {
      debug_log('readfile: ' + path);
      fs.readFile(path, 'utf8', function (err, data) {
        if (err) {
          debug_log(err);
          var output = {
            command: '',
            response: 'ERROR: File Upload Failed',
          };
          uploadedgcode = '';
        }
        if (data) {
          if (path.endsWith('.obc')) {
            // OpenBuildsCAM Workspace
            uploadedworkspace = data;
            const { shell } = require('electron');
            shell.openExternal('https://cam.openbuilds.com');
          } else {
            // GCODE
            var payload = {
              gcode: data,
              filename: path,
            };
            io.sockets.emit('gcodeupload', payload);
            uploadedgcode = data;
            return data;
          }
        }
      });
    }
  }
}

function machineSend(gcode) {
  // console.time('MachineSend');
  // debug_log("SENDING: " + gcode)
  if (port.isOpen) {
    if (gcode.match(/T([\d.]+)/i)) {
      var tool = parseFloat(RegExp.$1);
      status.machine.tool.nexttool.number = tool;
      status.machine.tool.nexttool.line = gcode;
    }
    var queueLeft = parseInt(gcodeQueue.length - queuePointer);
    var queueTotal = parseInt(gcodeQueue.length);
    // debug_log("Q: " + queueLeft)
    var data = [];
    data.push(queueLeft);
    data.push(queueTotal);
    io.sockets.emit('queueCount', data);
    // debug_log(gcode)
    port.write(gcode);
  } else {
    debug_log('PORT NOT OPEN');
  }
  // console.timeEnd('MachineSend');
}

function stopPort() {
  clearInterval(queueCounter);
  clearInterval(statusLoop);
  status.comms.interfaces.activePort = false;
  status.comms.interfaces.activeBaud = false;
  status.comms.connectionStatus = 0;
  status.machine.firmware.type = '';
  status.machine.firmware.version = ''; // get version
  status.machine.firmware.date = '';
  status.machine.firmware.buffer = '';
  gcodeQueue.length = 0;
  sentBuffer.length = 0; // dump bufferSizes
  port.drain(port.close());
}

function stopPortPendant() {
  status.comms.interfaces.activePortPendant = false;
  status.comms.interfaces.activeBaudPendant = false;
  status.comms.connectionStatusPendant = 0;
  portPendant.drain(portPendant.close());
}

function parseFeedback(data) {
  // debug_log(data)
  var state = data.substring(1, data.search(/(,|\|)/));
  status.comms.runStatus = state;
  if (state == 'Alarm') {
    // debug_log("ALARM:  " + data)
    status.comms.connectionStatus = 5;
    switch (status.machine.firmware.type) {
      case 'grbl':
        // sentBuffer.shift();
        var alarmCode = parseInt(data.split(':')[1]);
        debug_log('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
        status.comms.alarm = alarmCode + ' - ' + grblStrings.alarms(alarmCode);
        break;
    }
    status.comms.connectionStatus = 5;
  }
  if (status.machine.firmware.type == 'grbl') {
    // Extract work offset (for Grbl > 1.1 only!)
    var startWCO = data.search(/wco:/i) + 4;
    var wco;
    if (startWCO > 4) {
      wco = data.replace('>', '').substr(startWCO).split(/,|\|/, 4);
    }
    if (Array.isArray(wco)) {
      xOffset = parseFloat(wco[0]).toFixed(config.posDecimals);
      yOffset = parseFloat(wco[1]).toFixed(config.posDecimals);
      zOffset = parseFloat(wco[2]).toFixed(config.posDecimals);
      if (has4thAxis) {
        aOffset = parseFloat(wco[3]).toFixed(config.posDecimals);
        status.machine.position.offset.x = parseFloat(xOffset);
        status.machine.position.offset.y = parseFloat(yOffset);
        status.machine.position.offset.z = parseFloat(zOffset);
        status.machine.position.offset.a = parseFloat(aOffset);
      } else {
        status.machine.position.offset.x = parseFloat(xOffset);
        status.machine.position.offset.y = parseFloat(yOffset);
        status.machine.position.offset.z = parseFloat(zOffset);
      }
    }
    // Extract wPos (for Grbl > 1.1 only!)
    var startWPos = data.search(/wpos:/i) + 5;
    var wPos;
    if (startWPos > 5) {
      var wPosLen = data.substr(startWPos).search(/>|\|/);
      wPos = data.substr(startWPos, wPosLen).split(/,/);
    }
    var startMPos = data.search(/mpos:/i) + 5;
    var mPos;
    if (startMPos > 5) {
      var mPosLen = data.substr(startMPos).search(/>|\|/);
      mPos = data.substr(startMPos, mPosLen).split(/,/);
    }
    // If we got a WPOS
    if (Array.isArray(wPos)) {
      // debug_log('wpos')
      if (xPos !== parseFloat(wPos[0]).toFixed(config.posDecimals)) {
        xPos = parseFloat(wPos[0]).toFixed(config.posDecimals);
      }
      if (yPos !== parseFloat(wPos[1]).toFixed(config.posDecimals)) {
        yPos = parseFloat(wPos[1]).toFixed(config.posDecimals);
      }
      if (zPos !== parseFloat(wPos[2]).toFixed(config.posDecimals)) {
        zPos = parseFloat(wPos[2]).toFixed(config.posDecimals);
      }
      if (wPos.length > 3) {
        if (aPos !== parseFloat(wPos[3]).toFixed(config.posDecimals)) {
          aPos = parseFloat(wPos[3]).toFixed(config.posDecimals);
          has4thAxis = true;
        }
      }
      if (has4thAxis) {
        status.machine.position.work.x = parseFloat(xPos);
        status.machine.position.work.y = parseFloat(yPos);
        status.machine.position.work.z = parseFloat(zPos);
        status.machine.position.work.a = parseFloat(aPos);
      } else {
        status.machine.position.work.x = parseFloat(xPos);
        status.machine.position.work.y = parseFloat(yPos);
        status.machine.position.work.z = parseFloat(zPos);
      }
      // end is WPOS
    } else if (Array.isArray(mPos)) {
      // debug_log('mpos', mPos)
      if (xPos !== parseFloat(mPos[0]).toFixed(config.posDecimals)) {
        xPos = parseFloat(mPos[0]).toFixed(config.posDecimals);
      }
      if (yPos !== parseFloat(mPos[1]).toFixed(config.posDecimals)) {
        yPos = parseFloat(mPos[1]).toFixed(config.posDecimals);
      }
      if (zPos !== parseFloat(mPos[2]).toFixed(config.posDecimals)) {
        zPos = parseFloat(mPos[2]).toFixed(config.posDecimals);
      }
      if (mPos.length > 3) {
        if (aPos !== parseFloat(mPos[3]).toFixed(config.posDecimals)) {
          aPos = parseFloat(mPos[3]).toFixed(config.posDecimals);
          has4thAxis = true;
        }
      }
      if (has4thAxis) {
        status.machine.position.work.x = parseFloat(
          parseFloat(xPos - status.machine.position.offset.x).toFixed(config.posDecimals)
        );
        status.machine.position.work.y = parseFloat(
          parseFloat(yPos - status.machine.position.offset.y).toFixed(config.posDecimals)
        );
        status.machine.position.work.z = parseFloat(
          parseFloat(zPos - status.machine.position.offset.z).toFixed(config.posDecimals)
        );
        status.machine.position.work.a = parseFloat(
          parseFloat(aPos - status.machine.position.offset.a).toFixed(config.posDecimals)
        );
      } else {
        status.machine.position.work.x = parseFloat(
          parseFloat(xPos - status.machine.position.offset.x).toFixed(config.posDecimals)
        );
        status.machine.position.work.y = parseFloat(
          parseFloat(yPos - status.machine.position.offset.y).toFixed(config.posDecimals)
        );
        status.machine.position.work.z = parseFloat(
          parseFloat(zPos - status.machine.position.offset.z).toFixed(config.posDecimals)
        );
      }
      // end if MPOS
    }
  }
  // Extract override values (for Grbl > v1.1 only!)
  var startOv = data.search(/ov:/i) + 3;
  if (startOv > 3) {
    var ov = data.replace('>', '').substr(startOv).split(/,|\|/, 3);
    if (Array.isArray(ov)) {
      if (ov[0]) {
        status.machine.overrides.feedOverride = parseInt(ov[0]);
      }
      if (ov[1]) {
        status.machine.overrides.rapidOverride = parseInt(ov[1]);
      }
      if (ov[2]) {
        status.machine.overrides.spindleOverride = parseInt(ov[2]);
      }
    }
  }
  // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
  var startFS = data.search(/FS:/i) + 3;
  if (startFS > 3) {
    var fs = data.replace('>', '').substr(startFS).split(/,|\|/);
    if (Array.isArray(fs)) {
      if (fs[0]) {
        status.machine.overrides.realFeed = parseInt(fs[0]);
      }
      if (fs[1]) {
        status.machine.overrides.realSpindle = parseInt(fs[1]);
      }
    }
  }
  // Extract Pin Data
  var startPin = data.search(/Pn:/i) + 3;
  if (startPin > 3) {
    var pinsdata = data.replace('>', '').replace('\r', '').substr(startPin).split(/,|\|/, 1);
    var pins = pinsdata[0].split('');
    status.machine.inputs = pins;
    if (!_.isEqual(pins, oldpinslist)) {
      if (pins.includes('H')) {
        // pause
        pause();
        var output = {
          command: '[external from hardware]',
          response:
            'OpenBuilds CONTROL received a FEEDHOLD notification from Grbl: This could be due to someone pressing the HOLD button (if connected), or DriverMinder on the xPROv4 detected a driver fault',
        };
        io.sockets.emit('data', output);
      } // end if HOLD

      if (pins.includes('R')) {
        // abort
        stop(true);
        var output = {
          command: '[external from hardware]',
          response:
            'OpenBuilds CONTROL received a RESET/ABORT notification from Grbl: This could be due to someone pressing the RESET/ABORT button (if connected), or DriverMinder on the xPROv4 detected a driver fault',
        };
        io.sockets.emit('data', output);
      } // end if ABORT

      if (pins.includes('S')) {
        // abort
        unpause();
        var output = {
          command: '[external from hardware]',
          response:
            'OpenBuilds CONTROL received a CYCLESTART/RESUME notification from Grbl: This could be due to someone pressing the CYCLESTART/RESUME button (if connected)',
        };
        io.sockets.emit('data', output);
      } // end if RESUME/START
    }
  } else {
    status.machine.inputs = [];
  }
  oldpinslist = pins;
  // Extract Buffer Data
  var startBuf = data.search(/Bf:/i) + 3;
  if (startBuf > 3) {
    var buffer = data.replace('>', '').replace('\r', '').substr(startBuf).split(/,|\|/, 2);
    // debug_log("BUF: " + JSON.stringify(buffer, null, 2));
    status.machine.firmware.buffer = buffer;
  } else {
    status.machine.firmware.buffer = [];
  }
  // end statusreport
}

function laserTest(data) {
  if (status.comms.connectionStatus > 0) {
    data = data.split(',');
    var power = parseFloat(data[0]);
    var duration = parseInt(data[1]);
    var maxS = parseFloat(data[2]);
    if (power > 0) {
      if (!laserTestOn) {
        // laserTest is off
        // debug_log('laserTest: ' + 'Power ' + power + ', Duration ' + duration + ', maxS ' + maxS);
        if (duration >= 0) {
          switch (status.machine.firmware.type) {
            case 'grbl':
              addQToEnd('G1F1');
              addQToEnd('M3S' + parseInt((power * maxS) / 100));
              laserTestOn = true;
              io.sockets.emit('laserTest', power);
              if (duration > 0) {
                addQToEnd('G4 P' + duration / 1000);
                addQToEnd('M5S0');
                laserTestOn = false;
              }
              send1Q();
              break;
          }
        }
      } else {
        // debug_log('laserTest: ' + 'Power off');
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('M5S0');
            send1Q();
            break;
        }
        laserTestOn = false;
        io.sockets.emit('laserTest', 0);
      }
    }
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

// queue
function BufferSpace(firmware) {
  var total = 0;
  var len = sentBuffer.length;
  for (var i = 0; i < len; i++) {
    total += sentBuffer[i].length;
  }
  if (firmware == 'grbl') {
    return GRBL_RX_BUFFER_SIZE - total;
  }
}

function send1Q() {
  // console.time('send1Q');
  var gcode;
  var gcodeLen = 0;
  var spaceLeft = 0;
  if (status.comms.connectionStatus > 0) {
    switch (status.machine.firmware.type) {
      case 'grbl':
        if (gcodeQueue.length - queuePointer > 0 && !status.comms.blocked && !status.comms.paused) {
          spaceLeft = BufferSpace('grbl');
          if (gcodeQueue[queuePointer].length < spaceLeft) {
            gcode = gcodeQueue[queuePointer];
            queuePointer++;
            sentBuffer.push(gcode);
            machineSend(gcode + '\n');
            // debug_log('Sent: ' + gcode + ' Q: ' + (gcodeQueue.length - queuePointer) + ' Bspace: ' + (spaceLeft - gcode.length - 1));
          } else {
            status.comms.blocked = true;
          }
        }
        break;
    }
    if (queuePointer >= gcodeQueue.length) {
      status.comms.connectionStatus = 2; // finished
      clearInterval(queueCounter);
      gcodeQueue.length = 0; // Dump the Queye
      queuePointer = 0;
      status.comms.connectionStatus = 2; // finished
      var data = {
        completed: true,
        jobCompletedMsg: jobCompletedMsg,
      };
      io.sockets.emit('jobComplete', data);
      jobCompletedMsg = '';
    }
  } else {
    debug_log('Not Connected');
  }
  // console.timeEnd('send1Q');
}

function addQToEnd(gcode) {
  // debug_log('added ' + gcode)
  gcodeQueue.push(gcode);
}

function addQToStart(gcode) {
  gcodeQueue.unshift(gcode);
}

function addQRealtime(gcode) {
  // realtime command skip the send1Q as it doesnt respond with an ok
  machineSend(gcode);
}

// Electron
function isElectron() {
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }
  if (typeof process !== 'undefined' && process.versions && !!process.versions.electron) {
    return true;
  }
  return false;
}

if (isElectron()) {
  const gotTheLock = electronApp.requestSingleInstanceLock();
  var lauchGUI = true;
  if (!gotTheLock) {
    debug_log('Already running! Check the System Tray');
    electronApp.exit(0);
    electronApp.quit();
  } else {
    electronApp.on('second-instance', (event, commandLine, workingDirectory) => {
      //Someone tried to run a second instance, we should focus our window.
      // debug_log('SingleInstance')

      function checkFileType(fileName) {
        var fileNameLC = fileName.toLowerCase();
        if (
          fileNameLC.endsWith('.obc') ||
          fileName.endsWith('.gcode') ||
          fileName.endsWith('.gc') ||
          fileName.endsWith('.tap') ||
          fileName.endsWith('.nc') ||
          fileName.endsWith('.cnc')
        ) {
          return fileName;
        }
      }

      debug_log(commandLine);
      lauchGUI = true;

      var openFilePath = commandLine.find(checkFileType);
      if (openFilePath !== '') {
        readFile(openFilePath);
        if (openFilePath !== undefined) {
          if (openFilePath.endsWith('.obc')) {
            lauchGUI = false;
          } else {
            lauchGUI = true;
          }
        }
      }

      if (lauchGUI) {
        if (jogWindow === null) {
          createJogWindow();
          jogWindow.show();
          jogWindow.setAlwaysOnTop(true);
          jogWindow.focus();
          jogWindow.setAlwaysOnTop(false);
        } else {
          jogWindow.show();
          jogWindow.setAlwaysOnTop(true);
          jogWindow.focus();
          jogWindow.setAlwaysOnTop(false);
        }
      }
    });
    // Create myWindow, load the rest of the app, etc...
    app.on('ready', () => {});
  }

  if (electronApp) {
    // Module to create native browser window.

    function createApp() {
      createTrayIcon();
      if (process.platform == 'darwin') {
        debug_log('Creating MacOS Menu');
        createMenu();
        status.driver.operatingsystem = 'macos';
      }
      if (process.platform == 'win32' && process.argv.length >= 2) {
        var openFilePath = process.argv[1];
        if (openFilePath !== '') {
          debug_log('path' + openFilePath);
          readFile(openFilePath);
        }
        status.driver.operatingsystem = 'windows';
      }

      if (process.platform == 'darwin' || uploadedgcode.length > 1) {
        if (jogWindow === null) {
          createJogWindow();
          jogWindow.show();
          jogWindow.setAlwaysOnTop(true);
          jogWindow.focus();
          jogWindow.setAlwaysOnTop(false);
        } else {
          jogWindow.show();
          jogWindow.setAlwaysOnTop(true);
          jogWindow.focus();
          jogWindow.setAlwaysOnTop(false);
        }
      }
    }

    function createMenu() {
      var template = [
        {
          label: 'Application',
          submenu: [
            {
              label: 'Quit',
              accelerator: 'Command+Q',
              click: function () {
                if (appIcon) {
                  appIcon.destroy();
                }
                electronApp.exit(0);
              },
            },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            {
              label: 'Cut',
              accelerator: 'CmdOrCtrl+X',
              selector: 'cut:',
            },
            {
              label: 'Copy',
              accelerator: 'CmdOrCtrl+C',
              selector: 'copy:',
            },
            {
              label: 'Paste',
              accelerator: 'CmdOrCtrl+V',
              selector: 'paste:',
            },
            {
              label: 'Select All',
              accelerator: 'CmdOrCtrl+A',
              selector: 'selectAll:',
            },
          ],
        },
      ];

      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    function createTrayIcon() {
      if (process.platform !== 'darwin') {
        appIcon = new Tray(nativeImage.createFromPath(iconPath));
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Open User Interface (GUI)',
            click() {
              // debug_log("Clicked Systray")
              if (jogWindow === null) {
                createJogWindow();
                jogWindow.show();
                jogWindow.setAlwaysOnTop(true);
                jogWindow.focus();
                jogWindow.setAlwaysOnTop(false);
              } else {
                jogWindow.show();
                jogWindow.setAlwaysOnTop(true);
                jogWindow.focus();
                jogWindow.setAlwaysOnTop(false);
              }
            },
          },
          {
            label: 'Quit OpenBuilds CONTROL (Disables all integration until started again)',
            click() {
              if (appIcon) {
                appIcon.destroy();
              }
              electronApp.exit(0);
            },
          },
        ]);
        if (appIcon) {
          appIcon.on('click', function () {
            // debug_log("Clicked Systray")
            if (jogWindow === null) {
              createJogWindow();
              jogWindow.show();
              jogWindow.setAlwaysOnTop(true);
              jogWindow.focus();
              jogWindow.setAlwaysOnTop(false);
            } else {
              jogWindow.show();
              jogWindow.setAlwaysOnTop(true);
              jogWindow.focus();
              jogWindow.setAlwaysOnTop(false);
            }
          });
        }

        if (appIcon) {
          appIcon.on('balloon-click', function () {
            // debug_log("Clicked Systray")
            if (jogWindow === null) {
              createJogWindow();
              jogWindow.show();
              jogWindow.setAlwaysOnTop(true);
              jogWindow.focus();
              jogWindow.setAlwaysOnTop(false);
            } else {
              jogWindow.show();
              jogWindow.setAlwaysOnTop(true);
              jogWindow.focus();
              jogWindow.setAlwaysOnTop(false);
            }
          });
        }

        // Call this again for Linux because we modified the context menu
        if (appIcon) {
          appIcon.setContextMenu(contextMenu);
        }

        if (appIcon) {
          appIcon.displayBalloon({
            icon: nativeImage.createFromPath(iconPath),
            title: 'OpenBuilds CONTROL Started',
            content: 'OpenBuilds CONTROL has started successfully: Active on ' + ip.address() + ':' + config.webPort,
          });
        }
      } else {
        const dockMenu = Menu.buildFromTemplate([
          {
            label: 'Quit OpenBuilds CONTROL (Disables all integration until started again)',
            click() {
              // appIcon.destroy();
              electronApp.exit(0);
            },
          },
        ]);
        electronApp.dock.setMenu(dockMenu);
      }
    }

    function createJogWindow() {
      // Create the browser window.
      jogWindow = new BrowserWindow({
        // 1366 * 768 == minimum to cater for
        width: 870,
        height: 850,
        fullscreen: false,
        center: true,
        resizable: true,
        title: 'OpenBuilds CONTROL ',
        frame: false,
        autoHideMenuBar: true,
        icon: '/app/favicon.png',
        webgl: true,
        experimentalFeatures: true,
        experimentalCanvasFeatures: true,
        offscreen: true,
      });

      jogWindow.setOverlayIcon(nativeImage.createFromPath(iconPath), 'Icon');
      var ipaddr = ip.address();
      // jogWindow.loadURL(`//` + ipaddr + `:3000/`)
      jogWindow.loadURL('http://localhost:3000/');
      // jogWindow.webContents.openDevTools()

      jogWindow.on('close', function (event) {
        if (!forceQuit) {
          event.preventDefault();
          jogWindow.hide();
          return false;
        }
      });

      // Emitted when the window is closed.
      jogWindow.on('closed', function () {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        jogWindow = null;
      });
      jogWindow.once('ready-to-show', () => {
        jogWindow.show();
        jogWindow.setAlwaysOnTop(true);
        jogWindow.focus();
        jogWindow.setAlwaysOnTop(false);
      });
    }

    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    electronApp.on('ready', createApp);

    electronApp.on('before-quit', function () {
      forceQuit = true;
    });

    electronApp.on('will-quit', function (event) {
      // On OS X it is common for applications and their menu bar
      // to stay active until the user quits explicitly with Cmd + Q
      // We don't take that route, we close it completely
      if (appIcon) {
        appIcon.destroy();
      }
      electronApp.exit(0);
    });

    // Quit when all windows are closed.
    electronApp.on('window-all-closed', function () {
      // On OS X it is common for applications and their menu bar
      // to stay active until the user quits explicitly with Cmd + Q
      if (appIcon) {
        appIcon.destroy();
      }
      electronApp.exit(0);
    });

    electronApp.on('activate', function () {
      // On OS X it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) {
        createApp();
      }
    });

    // Autostart on Login
    if (!process.platform == 'darwin') {
      electronApp.setLoginItemSettings({
        openAtLogin: true,
        args: [],
      });
    }
  }
} else {
  var isPi = require('detect-rpi');
  if (isPi()) {
    debug_log('Running on Raspberry Pi!');
    status.driver.operatingsystem = 'rpi';
    startChrome();
    status.driver.operatingsystem = 'raspberrypi';
  } else {
    debug_log('Running under NodeJS...');
  }
}

function stop(jog) {
  if (status.comms.connectionStatus > 0) {
    status.comms.paused = true;
    debug_log('STOP');
    switch (status.machine.firmware.type) {
      case 'grbl':
        if (jog) {
          addQRealtime(String.fromCharCode(0x85)); // canceljog
          debug_log('Sent: 0x85 Jog Cancel');
        } else {
          addQRealtime('!'); // hold
          debug_log('Sent: !');
        }
        if (status.machine.firmware.version === '1.1d') {
          addQRealtime(String.fromCharCode(0x9e)); // Stop Spindle/Laser
          debug_log('Sent: Code(0x9E)');
        }
        debug_log('Cleaning Queue');
        if (!jog) {
          addQRealtime(String.fromCharCode(0x18)); // ctrl-x
          debug_log('Sent: Code(0x18)');
        }
        status.comms.connectionStatus = 2;
        break;
    }
    clearInterval(queueCounter);
    status.comms.queue = 0;
    queuePointer = 0;
    gcodeQueue.length = 0; // Dump the queue
    sentBuffer.length = 0; // Dump the queue
    // sentBuffer.length = 0; // Dump bufferSizes
    laserTestOn = false;
    status.comms.blocked = false;
    status.comms.paused = false;
    status.comms.runStatus = 'Stopped';
    status.comms.alarm = '';
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function pause() {
  if (status.comms.connectionStatus > 0) {
    status.comms.paused = true;
    debug_log('PAUSE');
    switch (status.machine.firmware.type) {
      case 'grbl':
        addQRealtime('!'); // Send hold command
        debug_log('Sent: !');
        if (status.machine.firmware.version === '1.1d') {
          addQRealtime(String.fromCharCode(0x9e)); // Stop Spindle/Laser
          debug_log('Sent: Code(0x9E)');
        }
        break;
    }
    status.comms.runStatus = 'Paused';
    status.comms.connectionStatus = 4;
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function unpause() {
  if (status.comms.connectionStatus > 0) {
    debug_log('UNPAUSE');
    switch (status.machine.firmware.type) {
      case 'grbl':
        addQRealtime('~'); // Send resume command
        debug_log('Sent: ~');
        break;
    }
    status.comms.paused = false;
    status.comms.blocked = false;
    setTimeout(function () {
      send1Q(); // restart queue
    }, 200);
    status.comms.runStatus = 'Resuming';
    status.comms.connectionStatus = 3;
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function isJson(item) {
  item = typeof item !== 'string' ? JSON.stringify(item) : item;

  try {
    item = JSON.parse(item);
  } catch (e) {
    return false;
  }

  if (typeof item === 'object' && item !== null) {
    return true;
  }

  return false;
}

function startChrome() {
  if (status.driver.operatingsystem == 'rpi') {
    const { spawn } = require('child_process');
    const chrome = spawn('chromium-browser', ['-app=http://127.0.0.1:3000']);
    chrome.on('close', (code) => {
      debug_log(`Chromium process exited with code ${code}`);
      debug_log(
        `If you want to continue using OpenBuildsCONTROL, please open Chromium Browser to http://` + ip.address() + `:3000`
      );
    });
  } else {
    debug_log('Not a Raspberry Pi. Please use Electron Instead');
  }
}

process.on('exit', () => debug_log('exit'));
