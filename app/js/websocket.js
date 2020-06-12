var socket, laststatus, lastPendantStatus;
var server = ''; //192.168.14.100';
var programBoard = {};
var grblParams = {};
var smoothieParams = {};
var nostatusyet = true;
var safeToUpdateSliders = false;
var simstopped = false;
var bellstate = false;
var toast = Metro.toast.create;
var unit = 'mm';

$(document).ready(function () {
  initSocket();

  $('#command').inputHistory({
    enter: function () {
      $('#sendCommand').click();
    },
  });

  $('form').submit(function () {
    return false;
  });
});

function showGrbl(bool) {
  if (bool) {
    sendGcode('$$');
    sendGcode('$I');
    $('#grblButtons').show();
    $('#firmwarename').html('Grbl');
  } else {
    $('#grblButtons').hide();
    $('#firmwarename').html('');
  }
}

function printLog(string) {
  if (!disableSerialLog) {
    if (document.getElementById('console') !== null) {
      if (string.isString) {
        // split(/\r\n|\n|\r/);
        string = string.replace(/\r\n|\n|\r/, '<br />');
      }
      if ($('#console p').length > 100) {
        // remove oldest if already at 300 lines
        $('#console p').first().remove();
      }
      var template = '<p class="pf">';
      var time = new Date();

      template +=
        '<span class="fg-brandColor1">[' +
        (time.getHours() < 10 ? '0' : '') +
        time.getHours() +
        ':' +
        (time.getMinutes() < 10 ? '0' : '') +
        time.getMinutes() +
        ':' +
        (time.getSeconds() < 10 ? '0' : '') +
        time.getSeconds() +
        ']</span> ';
      template += string;
      $('#console').append(template);
      $('#console').scrollTop($('#console')[0].scrollHeight - $('#console').height() + 20);
    }
  }
}

function initSocket() {
  socket = io.connect(server); // socket.io init
  printLog("<span class='fg-red'>[ Websocket ] </span><span class='fg-green'>Bidirectional Websocket Interface Started</span>");
  setTimeout(function () {
    populatePortsMenu();
    populatePortsMenuPendant();
  }, 2000);

  socket.on('disconnect', function () {
    console.log('WEBSOCKET DISCONNECTED');
    printLog(
      "<span class='fg-red'>[ Websocket ] </span><span class='fg-brown'> Disconnected.  OpenBuilds CONTROL probably quit or crashed</span>"
    );
    $('#websocketstatus').html('Disconnected');
  });

  socket.on('connect', function () {
    $('#websocketstatus').html('Connected');
  });

  socket.on('gcodeupload', function (data) {
    printLog('Received new GCODE from API');
    editor.session.setValue(data.gcode);
    loadedFileName = data.filename;
    setWindowTitle();
    parseGcodeInWebWorker(data.gcode);
    $('#controlTab').click();
    if (webgl) {
      $('#gcodeviewertab').click();
    } else {
      $('#gcodeeditortab').click();
    }
  });

  socket.on('gcodeupload', function (data) {
    printLog('Activated window');
  });

  socket.on('integrationpopup', function (data) {
    printLog('Integration called from ' + data);
    // editor.session.setValue(data);
    $('#controlTab').click();
    $('#consoletab').click();
    // gcodeeditortab
  });

  socket.on('updatedata', function (data) {
    // console.log(data.length, data)
    var toPrint = data.response;
    printLog("<span class='fg-red'>[ " + data.command + " ]</span>  <span class='fg-green'>" + toPrint + '</span>');
  });

  socket.on('updateready', function (data) {
    // 0 = not connected
    // 1 = Connected, but not Playing yet
    // 2 = Connected, but not Playing yet
    // 3 = Busy Streaming GCODE
    // 4 = Paused
    // 5 = Alarm State
    // 6 = Firmware Upgrade State
    if (laststatus.comms.connectionStatus < 3 && !continuousJogRunning) {
      $('#availVersion').html(data);
      getChangelog();
      Metro.dialog.open('#downloadUpdate');
    }
  });

  socket.on('updateprogress', function (data) {
    $('#downloadprogress').html(data + '%');
  });

  socket.on('data', function (data) {
    // console.log(data)
    var toPrint = escapeHTML(data.response);

    // Parse Grbl Settings Feedback
    if (data.response.indexOf('$') === 0) {
      if (typeof grblSettings !== 'undefined') {
        grblSettings(data.response);
        var key = data.response.split('=')[0].substr(1);
        var descr = grblSettingCodes[key];
        toPrint = data.response + '  ;' + descr;
        printLog("<span class='fg-red'>[ " + data.command + " ]</span>  <span class='fg-green'>" + toPrint + '</span>');
      }
    } else {
      printLog("<span class='fg-red'>[ " + data.command + " ]</span>  <span class='fg-green'>" + toPrint + '</span>');
    }
  });

  socket.on('grbl', function (data) {
    showGrbl(true);
  });

  socket.on('prbResult', function (data) {
    z0proberesult(data);
  });

  socket.on('jobComplete', function (data) {
    // console.log("jobComplete", data)

    if (data.completed) {
      // console.log("Job Complete", data)
    }
    if (data.jobCompletedMsg && data.jobCompletedMsg.length > 0) {
      $('#completeMsgDiv').html(data.jobCompletedMsg);
      Metro.dialog.open('#completeMsgModal');
    }
  });

  socket.on('machinename', function (data) {
    if (typeof setMachineButton !== 'undefined') {
      setMachineButton(data);
    }
  });

  socket.on('queueCount', function (data) {
    // calc percentage
    var left = data[0];
    var total = data[1];
    var done = total - left;
    var donepercent = (done / total) * 100;
    var progressbar = $('#progressbar').data('progress');
    if (progressbar) {
      progressbar.val(donepercent);
    }
    if (laststatus) {
      if (laststatus.comms.connectionStatus == 3) {
        editor.gotoLine(data[1] - data[0]);
      }
      if (typeof object !== 'undefined' && done > 0) {
        if (object.userData !== 'undefined' && object.userData && object.userData.lines.length > 2) {
          var timeremain =
            object.userData.lines[object.userData.lines.length - 1].p2.timeMinsSum - object.userData.lines[done].p2.timeMinsSum;
        }
        if (!isNaN(timeremain)) {
          var mins_num = parseFloat(timeremain, 10); // don't forget the second param
          var hours = Math.floor(mins_num / 60);
          var minutes = Math.floor(mins_num - (hours * 3600) / 60);
          var seconds = Math.floor(mins_num * 60 - hours * 3600 - minutes * 60);

          // Appends 0 when unit is less than 10
          if (hours < 10) {
            hours = '0' + hours;
          }
          if (minutes < 10) {
            minutes = '0' + minutes;
          }
          if (seconds < 10) {
            seconds = '0' + seconds;
          }
          var formattedTime = hours + ':' + minutes + ':' + seconds;
          // console.log('Remaining time: ', formattedTime)
          // output formattedTime to UI here
          $('#timeRemaining').html(' / ' + formattedTime);
        }
      } else {
        $('#timeRemaining').empty();
      }
    }
    $('#gcodesent').html('Job Queue: ' + data[0]);
  });

  socket.on('toastErrorAlarm', function (data) {
    console.log(data);
    printLog("<span class='fg-red'>[ ALARM ]</span>  <span class='fg-red'>" + data + '</span>');

    Metro.dialog.create({
      clsDialog: 'dark',
      title: "<i class='fas fa-exclamation-triangle'></i> Grbl Alarm:",
      content: "<i class='fas fa-exclamation-triangle fg-red'></i>  " + data,
      actions: [
        {
          caption: 'Clear Alarm',
          cls: 'js-dialog-close alert closeAlarmBtn',
          onclick: function () {
            socket.emit('clearAlarm', 2);
          },
        },
        {
          caption: 'Cancel',
          cls: 'js-dialog-close',
          onclick: function () {
            //
          },
        },
      ],
    });
    setTimeout(function () {
      $('.closeAlarmBtn').focus();
    }, 200);
    //
  });

  socket.on('toastError', function (data) {
    console.log(data);
    printLog("<span class='fg-red'>[ ERROR ]</span>  <span class='fg-red'>" + data + '</span>');

    Metro.dialog.create({
      title: "<i class='fas fa-exclamation-triangle'></i> Grbl Error:",
      content: "<i class='fas fa-exclamation-triangle fg-red'></i>  " + data,
      clsDialog: 'dark',
      actions: [
        {
          caption: 'OK',
          cls: 'js-dialog-close alert closeErrorBtn',
          onclick: function () {
            socket.emit('clearAlarm', 2);
          },
        },
      ],
    });
    setTimeout(function () {
      $('.closeErrorBtn').focus();
    }, 200);
    //
  });

  socket.on('progStatus', function (data) {
    $('#controlTab').click();
    $('#consoletab').click();
    console.log(data.port, data.string);
    var string = data.string;
    if (string) {
      if (string.indexOf('flash complete') != -1) {
        setTimeout(function () {
          populatePortsMenu();
          populatePortsMenuPendant();
        }, 400);
      }
      string = string.replace(
        '[31mflash complete.[39m',
        "<span class='fg-red'><i class='fas fa-times fa-fw fg-red fa-fw'> </i> FLASH FAILED!</span> "
      );
      string = string.replace('[32m', "<span class='fg-green'><i class='fas fa-check fa-fw fg-green fa-fw'></i> ");
      string = string.replace('[39m', '</span>');
      printLog("<span class='fg-red'>[ Firmware Upgrade ] </span>" + string);

      // $('#sendCommand').click();
    }
  });

  socket.on('status', function (status) {
    if (nostatusyet) {
      // $('#windowtitle').html("OpenBuilds CONTROL v" + status.driver.version)
      setWindowTitle(status);
      if (status.driver.operatingsystem == 'rpi') {
        $('#windowtitlebar').hide();
      }
    }
    nostatusyet = false;

    // if (!_.isEqual(status, laststatus)) {
    if (laststatus !== undefined) {
      if (!_.isEqual(status.comms.interfaces.ports, laststatus.comms.interfaces.ports)) {
        var string = 'Detected a change in available ports: ';
        for (i = 0; i < status.comms.interfaces.ports.length; i++) {
          string += '[' + status.comms.interfaces.ports[i].path + ']';
        }

        if (!status.comms.interfaces.ports.length) {
          string += '[ No devices connected ]';
        }
        printLog(string);
        laststatus.comms.interfaces.ports = status.comms.interfaces.ports;
        populatePortsMenu();
        populatePortsMenuPendant();
      }
    }

    $('#runStatus').html('Controller: ' + status.comms.runStatus);

    if (!disableDROupdates) {
      if (unit == 'mm') {
        var xpos = status.machine.position.work.x + unit;
        var ypos = status.machine.position.work.y + unit;
        var zpos = status.machine.position.work.z + unit;
      } else if (unit == 'in') {
        var xpos = (status.machine.position.work.x / 25.4).toFixed(2) + unit;
        var ypos = (status.machine.position.work.y / 25.4).toFixed(2) + unit;
        var zpos = (status.machine.position.work.z / 25.4).toFixed(2) + unit;
      }

      if ($('#xPos').html() != xpos) {
        $('#xPos').html(xpos);
      }
      if ($('#yPos').html() != ypos) {
        $('#yPos').html(ypos);
      }
      if ($('#zPos').html() != zpos) {
        $('#zPos').html(zpos);
      }
    } else {
      $('#xPos').html('disabled');
      $('#yPos').html('disabled');
      $('#zPos').html('disabled');
    }

    if (webgl) {
      if (!disable3Drealtimepos) {
        if (!isJogWidget) {
          if (!simRunning) {
            if (object) {
              cone.position.x = status.machine.position.work.x;
              cone.position.y = status.machine.position.work.y;
              cone.position.z = status.machine.position.work.z + 20;
              // }
            }
          }
        }
      }
    }

    if (safeToUpdateSliders) {
      if ($('#fro').data('slider') && $('#tro').data('slider')) {
        $('#fro').data('slider').val(status.machine.overrides.feedOverride);
        $('#tro').data('slider').val(status.machine.overrides.spindleOverride);
      }
    }

    // Windows Power Management
    if (status.driver.operatingsystem == 'windows') {
      $('#powerSettingsCard').show();
      if (status.driver.powersettings.usbselectiveAC == false) {
        $('#selectivesuspendAC').removeClass('alert').addClass('success').html('DISABLED');
      } else if (status.driver.powersettings.usbselectiveAC == null) {
        $('#selectivesuspendAC').removeClass('success').addClass('alert').html('UNKNOWN');
      } else if (status.driver.powersettings.usbselectiveAC == true) {
        $('#selectivesuspendAC').removeClass('success').addClass('alert').html('ENABLED');
      }

      if (status.driver.powersettings.usbselectiveDC == false) {
        $('#selectivesuspendDC').removeClass('alert').addClass('success').html('DISABLED');
      } else if (status.driver.powersettings.usbselectiveDC == null) {
        $('#selectivesuspendDC').removeClass('success').addClass('alert').html('UNKNOWN');
      } else if (status.driver.powersettings.usbselectiveDC == true) {
        $('#selectivesuspendDC').removeClass('success').addClass('alert').html('ENABLED');
      }
    } else {
      $('#powerSettingsCard').hide();
    }

    // Grbl Pins Input Status
    $('.pinstatus').removeClass('alert').addClass('success').html('OFF');
    $('#holdpin').html('HOLD/DOOR:OFF');
    $('#resetpin').html('RST:OFF');
    $('#startpin').html('START:OFF');
    if (status.machine.inputs.length > 0) {
      for (i = 0; i < status.machine.inputs.length; i++) {
        switch (status.machine.inputs[i]) {
          case 'X':
            // console.log('PIN: X-LIMIT');
            $('#xpin').removeClass('success').addClass('alert').html('ON');
            break;
          case 'Y':
            // console.log('PIN: Y-LIMIT');
            $('#ypin').removeClass('success').addClass('alert').html('ON');
            break;
          case 'Z':
            // console.log('PIN: Z-LIMIT');
            $('#zpin').removeClass('success').addClass('alert').html('ON');
            break;
          case 'P':
            // console.log('PIN: PROBE');
            $('#prbpin').removeClass('success').addClass('alert').html('ON');
            break;
          case 'D':
            // console.log('PIN: DOOR');
            $('#doorpin').removeClass('success').addClass('alert').html('ON');
            break;
          case 'H':
            // console.log('PIN: HOLD');
            $('#holdpin').removeClass('success').addClass('alert').html('HOLD:ON');
            break;
          case 'R':
            // console.log('PIN: SOFTRESET');
            $('#resetpin').removeClass('success').addClass('alert').html('RST:ON');
            break;
          case 'S':
            // console.log('PIN: CYCLESTART');
            $('#startpin').removeClass('success').addClass('alert').html('START:ON');
            break;
        }
      }
    }

    $('#driverver').html('v' + status.driver.version);
    if (!status.machine.firmware.type) {
      $('#firmwarever').html('NOCOMM');
    } else {
      $('#firmwarever').html(status.machine.firmware.type + ' v' + status.machine.firmware.version);
    }
    $('#commblocked').html(status.comms.blocked ? 'BLOCKED' : 'Ready');
    var string = '';
    switch (status.comms.connectionStatus) {
      case 0:
        string += 'Not Connected';
        break;
      case 2:
        string += 'Connected';
        break;
      case 3:
        string += 'Streaming';
        break;
      case 4:
        string += 'Paused';
        break;
      case 5:
        string += 'Alarmed';
        break;
    }
    $('#commstatus').html(string);
    $('#drvqueue').html(status.comms.queue);

    if (status.comms.interfaces.activePort) {
      $('#activeportstatus').html(status.comms.interfaces.activePort);
    } else {
      $('#activeportstatus').html('none');
    }

    // Set the Connection Toolbar option
    setConnectBar(status.comms.connectionStatus, status);
    setConnectBarPendant(status.comms.connectionStatusPendant, status);
    setControlBar(status.comms.connectionStatus, status);
    setJogPanel(status.comms.connectionStatus, status);
    setConsole(status.comms.connectionStatus, status);
    if (status.comms.connectionStatus != 5) {
      bellstate = false;
    }
    if (status.comms.connectionStatus == 0) {
      showGrbl(false);
    }

    laststatus = status;
  });

  socket.on('features', function (data) {
    // console.log('FEATURES', data)
    for (i = 0; i < data.length; i++) {
      switch (data[i]) {
        case 'Q':
          // console.log('SPINDLE_IS_SERVO Enabled')
          $('#enServo').removeClass('alert').addClass('success').html('ON');
          $('.servo-active').show();
          break;
        case 'V': //	Variable spindle enabled
          // console.log('Variable spindle enabled')
          $('#enVariableSpindle').removeClass('alert').addClass('success').html('ON');
          break;
        case 'N': //	Line numbers enabled
          // console.log('Line numbers enabled')
          $('#enLineNumbers').removeClass('alert').addClass('success').html('ON');
          break;
        case 'M': //	Mist coolant enabled
          // console.log('Mist coolant enabled')
          $('#menuMisting').show();
          $('#enMisting').removeClass('alert').addClass('success').html('ON');
          break;
        case 'C': //	CoreXY enabled
          // console.log('CoreXY enabled')
          $('#enCoreXY').removeClass('alert').addClass('success').html('ON');
          break;
        case 'P': //	Parking motion enabled
          // console.log('Parking motion enabled')
          $('#enParking').removeClass('alert').addClass('success').html('ON');
          break;
        case 'Z': //	Homing force origin enabled
          // console.log('Homing force origin enabled')
          $('#enHomingOrigin').removeClass('alert').addClass('success').html('ON');
          break;
        case 'H': //	Homing single axis enabled
          // console.log('Homing single axis enabled')
          $('#enSingleAxisHome').removeClass('alert').addClass('success').html('ON');
          break;
        case 'T': //	Two limit switches on axis enabled
          // console.log('Two limit switches on axis enabled')
          $('#enTwoLimits').removeClass('alert').addClass('success').html('ON');
          break;
        case 'A': //	Allow feed rate overrides in probe cycles
          // console.log('Allow feed rate overrides in probe cycles')
          $('#enFeedOVProbe').removeClass('alert').addClass('success').html('ON');
          break;
        case '$': //	Restore EEPROM $ settings disabled
          // console.log('Restore EEPROM $ settings disabled')
          $('#enEepromSettingsDisable').removeClass('alert').addClass('success').html('ON');
          break;
        case '#': //	Restore EEPROM parameter data disabled
          // console.log('Restore EEPROM parameter data disabled')
          $('#enEepromParamsDisable').removeClass('alert').addClass('success').html('ON');
          break;
        case 'I': //	Build info write user string disabled
          // console.log('Build info write user string disabled')
          $('#enBuildInfoDisabled').removeClass('alert').addClass('success').html('ON');
          break;
        case 'E': //	Force sync upon EEPROM write disabled
          // console.log('Force sync upon EEPROM write disabled')
          $('#enForceSyncEeprom').removeClass('alert').addClass('success').html('ON');
          break;
        case 'W': //	Force sync upon work coordinate offset change disabled
          // console.log('Force sync upon work coordinate offset change disabled')
          $('#enForceSyncWco').removeClass('alert').addClass('success').html('ON');
          break;
        case 'L': //	Homing init lock sets Grbl into an alarm state upon power up
          // console.log('Homing init lock sets Grbl into an alarm state upon power up')
          $('#enHomingInitLock').removeClass('alert').addClass('success').html('ON');
          break;
      }
    }
  });

  $('#sendCommand').on('click', function () {
    var commandValue = $('#command').val();
    sendGcode(commandValue);
    // $('#command').val('');
  });

  $('#command').on('keypress', function (e) {
    if (e.which === 13) {
      $(this).attr('disabled', 'disabled');
      var commandValue = $('#command').val();
      sendGcode(commandValue);
      $('#command').val('');
      $(this).removeAttr('disabled');
    }
  });

  var bellflash = setInterval(function () {
    if (!nostatusyet) {
      if (laststatus) {
        if (laststatus.comms.connectionStatus == 5) {
          if (bellstate == false) {
            $('#navbell').hide();
            $('#navbellBtn1').hide();
            $('#navbellBtn2').hide();
            $('#navbellBtn3').hide();
            bellstate = true;
          } else {
            $('#navbell').show();
            $('#navbellBtn1').show();
            $('#navbellBtn2').show();
            $('#navbellBtn3').show();
            bellstate = false;
          }
        } else {
          $('#navbell').hide();
          $('#navbellBtn1').hide();
          $('#navbellBtn2').hide();
          $('#navbellBtn3').hide();
        }
      }
    }
  }, 200);
}

function selectPort() {
  $('#consoletab').click();
  socket.emit('connectTo', 'usb,' + $('#portUSB').val() + ',' + '115200');
}

function selectPortPendant() {
  console.log('Clicking console tab...');
  $('#consoletab').click();
  console.log('emitting connectToPendant...');
  socket.emit('connectToPendant', 'usb,' + $('#portUSBPendant').val() + ',' + '57600');
}

function closePort() {
  socket.emit('closePort', 1);
  populatePortsMenu();
  $('.mdata').val('');
}

function closePortPendant() {
  socket.emit('closePortPendant', 1);
  populatePortsMenuPendant();
  $('.mdata').val('');
}

function populatePortsMenu() {
  var response = `<select id="select1" data-role="select" class="mt-4"><optgroup label="USB Ports">`;
  for (i = 0; i < laststatus.comms.interfaces.ports.length; i++) {
    var port = friendlyPort(i);
    response +=
      `<option value="` +
      laststatus.comms.interfaces.ports[i].path +
      `">` +
      port.note +
      ' ' +
      laststatus.comms.interfaces.ports[i].path.replace('/dev/tty.', '') +
      `</option>`;
  }
  if (!laststatus.comms.interfaces.ports.length) {
    response += `<option value="">Waiting for USB</option>`;
    $('#driverBtn').show();
  } else {
    $('#driverBtn').hide();
  }
  response += `</optgroup></select>`;
  var select = $('#portUSB').data('select');
  select.data(response);
  var select2 = $('#portUSB2').data('select');
  if (select2) {
    select2.data(response);
  }
  $('#portUSB').parent('.select').removeClass('disabled');
  $('#portUSB2').parent('.select').removeClass('disabled');
  $('#connectBtn').attr('disabled', false);
}

function populatePortsMenuPendant() {
  var response = `<select id="selectPendant" data-role="select" class="mt-4"><optgroup label="Pendant Ports">`;
  for (i = 0; i < laststatus.comms.interfaces.ports.length; i++) {
    var port = friendlyPort(i);
    response +=
      `<option value="` +
      laststatus.comms.interfaces.ports[i].path +
      `">` +
      port.note +
      ' ' +
      laststatus.comms.interfaces.ports[i].path.replace('/dev/tty.', '') +
      `</option>`;
  }
  if (!laststatus.comms.interfaces.ports.length) {
    response += `<option value="">Waiting for USB</option>`;
  }
  response += `</optgroup></select>`;
  var select = $('#portUSBPendant').data('select');
  select.data(response);

  $('#portUSBPendant').parent('.select').removeClass('disabled');
  $('#connectBtnPendant').attr('disabled', false);
}

function sendGcode(gcode) {
  if (gcode) {
    socket.emit('runCommand', gcode);
  }
}

function feedOverride(step) {
  if (socket) {
    socket.emit('feedOverride', step);
    $('#fro')
      .data('slider')
      .buff(((step - 10) * 100) / (200 - 10));
  }
}

function spindleOverride(step) {
  if (socket) {
    socket.emit('spindleOverride', step);
    $('#tro')
      .data('slider')
      .buff(((step - 10) * 100) / (200 - 10));
  }
}

function friendlyPort(i) {
  // var likely = false;
  var img = 'usb.png';
  var note = '';
  var manufacturer = laststatus.comms.interfaces.ports[i].manufacturer;
  if (manufacturer == `(Standard port types)`) {
    img = 'serial.png';
    note = 'Motherboard Serial Port';
  } else if (laststatus.comms.interfaces.ports[i].productId && laststatus.comms.interfaces.ports[i].vendorId) {
    if (laststatus.comms.interfaces.ports[i].productId == '6015' && laststatus.comms.interfaces.ports[i].vendorId == '1D50') {
      // found Smoothieboard
      img = 'smoothieboard.png';
      note = 'Smoothieware USB Port';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '6001' && laststatus.comms.interfaces.ports[i].vendorId == '0403') {
      // found FTDI FT232
      img = 'usb.png';
      note = 'FTDI USB to Serial';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '6015' && laststatus.comms.interfaces.ports[i].vendorId == '0403') {
      // found FTDI FT230x
      img = 'usb.png';
      note = 'FTDI USD to Serial';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '606D' && laststatus.comms.interfaces.ports[i].vendorId == '1D50') {
      // found TinyG G2
      img = 'usb.png';
      note = 'Tiny G2';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '003D' && laststatus.comms.interfaces.ports[i].vendorId == '2341') {
      // found Arduino Due Prog Port
      img = 'due.png';
      note = 'Arduino Due Prog';
    }
    if (
      (laststatus.comms.interfaces.ports[i].productId == '0043' && laststatus.comms.interfaces.ports[i].vendorId == '2341') ||
      (laststatus.comms.interfaces.ports[i].productId == '0001' && laststatus.comms.interfaces.ports[i].vendorId == '2341') ||
      (laststatus.comms.interfaces.ports[i].productId == '0043' && laststatus.comms.interfaces.ports[i].vendorId == '2A03')
    ) {
      // found Arduino Uno
      img = 'uno.png';
      note = 'Arduino Uno';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '2341' && laststatus.comms.interfaces.ports[i].vendorId == '0042') {
      // found Arduino Mega
      img = 'mega.png';
      note = 'Arduino Mega';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '7523' && laststatus.comms.interfaces.ports[i].vendorId == '1A86') {
      // found CH340
      img = 'uno.png';
      note = 'CH340 Arduino Fake';
    }
    if (laststatus.comms.interfaces.ports[i].productId == 'EA60' && laststatus.comms.interfaces.ports[i].vendorId == '10C4') {
      // found CP2102
      img = 'nodemcu.png';
      note = 'NodeMCU';
    }
    if (laststatus.comms.interfaces.ports[i].productId == '2303' && laststatus.comms.interfaces.ports[i].vendorId == '067B') {
      // found CP2102
      // img = 'nodemcu.png';
      note = 'Prolific USB to Serial';
    }
  } else {
    img = 'usb.png';
  }

  return {
    img: img,
    note: note,
  };
}

function escapeHTML(html) {
  return document.createElement('div').appendChild(document.createTextNode(html)).parentNode.innerHTML;
}
