  // ATOMORI_STATUS_HISTORY_V1 — display history only; never reuse it as control state.
  var conn = document.getElementById("conn");
  var atomoriStatusHistory = Object.create(null);
  var atomoriStatusBusy = false;
  function atomoriFresh(age, limit) {
    return Number.isFinite(age) && age >= 0 && age <= limit;
  }
  function atomoriReading(key, text, valid, age) {
    if (valid && typeof text === "string" && text) {
      atomoriStatusHistory[key] = { text: text, sampledAt: Date.now() - (Number.isFinite(age) && age >= 0 ? age * 1000 : 0) };
      return { text: text, retained: false, age: age };
    }
    var sample = atomoriStatusHistory[key];
    return sample ? { text: sample.text, retained: true, age: Math.max(0, (Date.now() - sample.sampledAt) / 1000) }
      : { text: "—", retained: false, age: null };
  }
  function atomoriPaint(id, reading) {
    var element = document.getElementById(id);
    if (!element) return;
    element.textContent = reading.text;
    element.style.color = reading.retained ? "#9aa8b6" : "";
    element.title = reading.retained ? "最近有效数据 · " + reading.age.toFixed(1) + " 秒前；当前未获得有效新样本" : "";
  }
  function atomoriValue(id, value, valid, age, digits, suffix) {
    var text = Number.isFinite(value) ? value.toFixed(digits) + (suffix || "") : "";
    atomoriPaint(id, atomoriReading(id, text, valid && Number.isFinite(value), age));
  }
  function renderDigitalInputs(digital) {
    ["sound", "alcohol", "mq2", "flame"].forEach(function (name) {
      var input = (digital || {})[name] || {};
      var valid = input.available === true && input.stale !== true && atomoriFresh(input.age_s, 2) && typeof input.triggered === "boolean";
      var text = input.triggered ? (name === "alcohol" ? "检测到声音" : "报警") : "正常";
      var reading = atomoriReading("digital." + name, text, valid, input.age_s);
      if (!valid && !reading.retained && input.available === true && input.stale !== true) reading.text = "状态未配置";
      atomoriPaint(name + "Value", reading);
      var element = document.getElementById(name + "Value");
      element.classList.toggle("sensor-alarm", valid && input.triggered);
      element.classList.toggle("sensor-normal", valid && !input.triggered);
      element.classList.toggle("sensor-unknown", !valid);
    });
  }
  function renderAnalogInputs(env) {
    var adc = env.analog || {};
    ["sound", "mq2"].forEach(function (name) {
      var input = (adc.channels || {})[name] || {}, reference = input.reference_estimate || {};
      var valid = adc.available === true && adc.stale !== true && atomoriFresh(adc.age_s, 2) && Number.isFinite(input.raw)
        && Number.isFinite(input.adc_voltage_v) && input.adc_voltage_v >= 0;
      var numericReference = valid && reference.status === "reference_only" && Number.isFinite(reference.ppm) && reference.ppm >= 0;
      var measurement = numericReference ? reference.ppm.toFixed(name === "sound" ? 1 : 0) + " ppm  " + (reference.ppm / 10000).toFixed(name === "sound" ? 5 : 3) + "%" : "";
      var reading = atomoriReading("analog." + name, measurement, numericReference, adc.age_s);
      var element = document.getElementById(name + "Value"), statusText = element.textContent;
      if (reading.text !== "—") {
        reading.text += " · " + statusText;
        if (element.title) { reading.retained = true; reading.age = Math.max(reading.age || 0, (atomoriReading("digital." + name, "", false, null).age || 0)); }
        atomoriPaint(name + "Value", reading);
        if (reading.retained) {
          element.classList.remove("sensor-alarm", "sensor-normal");
          element.classList.add("sensor-unknown");
        }
      }
      element.title += (element.title ? "；" : "") + "未标定模型参考值，不作为实测浓度";
    });
  }
  function atomoriRenderStatus(s) {
    var env = s.environment || {};
    renderDigitalInputs(env.digital);
    renderAnalogInputs(env);
    var environmentFresh = env.available === true && env.stale !== true && atomoriFresh(env.age_s, 15);
    atomoriValue("envTemperature", env.temperature_c, environmentFresh, env.age_s, 1, " °C");
    atomoriValue("envHumidity", env.humidity_percent, environmentFresh, env.age_s, 0, " % RH");
    var envState = document.getElementById("envState");
    envState.textContent = environmentFresh ? "温湿度已同步" : "等待有效采样 · 保留最近读数";
    envState.classList.toggle("bad", !environmentFresh);
    conn.textContent = "已连接";
    conn.classList.remove("bad");
    if (!(s.camera || {}).ready) {
      cameraWasOffline = true;
    } else if (cameraWasOffline) {
      cameraWasOffline = false;
      refreshCamera();
    }
    var ages = s.topic_ages_s || {}, odom = s.odom || {}, pose = odom.pose;
    var odomFresh = atomoriFresh(ages.odom, 2);
    var poseValid = odomFresh && Array.isArray(pose) && pose.length === 3 && pose.every(Number.isFinite);
    atomoriPaint("pose", atomoriReading("pose", poseValid ? pose.map(function (value) { return value.toFixed(2); }).join(" / ") : "", poseValid, ages.odom));
    atomoriValue("speed", odom.speed_mps, odomFresh && odom.speed_mps >= 0, ages.odom, 2, " m/s");
    var mux = s.ugv_control_mux || {}, muxFresh = atomoriFresh(ages.ugv_control_mux, 2);
    atomoriPaint("authority", atomoriReading("authority", mux.authority, muxFresh, ages.ugv_control_mux));
    atomoriPaint("reason", atomoriReading("reason", mux.reason, muxFresh, ages.ugv_control_mux));
    var gw = s.ugv_command_gateway || {}, gwValid = atomoriFresh(ages.ugv_command_gateway, 2) && Number.isFinite(gw.output_linear_mps) && Number.isFinite(gw.output_angular_rps);
    atomoriPaint("gw", atomoriReading("gw", gwValid ? gw.output_linear_mps.toFixed(2) + " / " + gw.output_angular_rps.toFixed(2) : "", gwValid, ages.ugv_command_gateway));
    [["ultrasonic", s.ultrasonic, true], ["ultrasonicLeft", s.ultrasonic_left, false], ["ultrasonicRight", s.ultrasonic_right, false]].forEach(function (channel) {
      var us = channel[1] || {}, valid = Number.isFinite(us.range) && us.range >= 0 && atomoriFresh(us.age_s, 1);
      atomoriValue(channel[0], us.range, valid, us.age_s, 2, " m");
      document.getElementById(channel[0]).className = valid && channel[2] && us.range < 0.25 ? "bad" : "";
    });
    // Existing controls use only this response. Display history is never consulted.
    var av = s.avoidance || {};
    cruiseAvail = av.available === true;
    if (typeof av.cruise_enabled === "boolean") cruiseOn = av.cruise_enabled;
    renderCruise();
    var ls = s.leadscrew || {}, lsSt = ls.status;
    pusherAvail = !!lsSt && atomoriFresh(ls.age_s, 2);
    if (pusherAvail && Array.isArray(lsSt.pos_mm) && lsSt.pos_mm.every(Number.isFinite)) {
      pusherClosed = !!ls.closed;
      renderPusher(" " + lsSt.pos_mm.map(function (value) { return value.toFixed(0); }).join("/") + "mm·" + (PUSHER_STATE_NAMES[(lsSt.state || [])[0]] || "?"));
    } else renderPusher("");
    var wasMapping = mappingOn;
    mappingOn = !!(s.mapping && s.mapping.active);
    if (!wasMapping && mappingOn) resetLiveMappingView();
    renderMapping();
    updateMappingProgress(s);
    if (wasMapping && !mappingOn) refreshSavedMaps();
    var gps = s.gps || {}, fix = gps.fix, gpsFresh = atomoriFresh(gps.age_s, 3);
    var gpsStatusValid = gpsFresh && fix && Number.isInteger(fix.status);
    atomoriPaint("gpsStatus", atomoriReading("gpsStatus", gpsStatusValid ? fix.status >= 0 ? "已定位" : "搜星中（无定位）" : "", gpsStatusValid, gps.age_s));
    var coordinatesValid = gpsStatusValid && fix.status >= 0 && Number.isFinite(fix.latitude) && Math.abs(fix.latitude) <= 90 && Number.isFinite(fix.longitude) && Math.abs(fix.longitude) <= 180;
    atomoriPaint("gpsPos", atomoriReading("gpsPos", coordinatesValid ? fix.latitude.toFixed(7) + " / " + fix.longitude.toFixed(7) : "", coordinatesValid, gps.age_s));
    atomoriValue("gpsAlt", fix && fix.altitude, gpsStatusValid && fix.status >= 0, gps.age_s, 1, " m");
    if (coordinatesValid) updateGpsMap(fix.longitude, fix.latitude);
    pollRobotPose(s);
  }
  function atomoriStatusFailed() {
    conn.textContent = "断开";
    conn.classList.add("bad");
    document.getElementById("envState").textContent = "连接断开 · 保留最近读数";
    document.getElementById("envState").classList.add("bad");
    renderDigitalInputs({}); renderAnalogInputs({});
    ["pose", "speed", "authority", "reason", "gw", "ultrasonic", "ultrasonicLeft", "ultrasonicRight", "envTemperature", "envHumidity", "gpsStatus", "gpsPos", "gpsAlt"].forEach(function (id) {
      atomoriPaint(id, atomoriReading(id, "", false, null));
      document.getElementById(id).classList.remove("bad");
    });
    cruiseAvail = false; pusherAvail = false;
    renderCruise(); renderPusher("");
    pollRobotPose(null);
  }
  async function pollStatus() {
    if (atomoriStatusBusy) return;
    atomoriStatusBusy = true;
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 1500), failed = false;
    try {
      var response = await fetch("/api/status", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("status HTTP " + response.status);
      var status = await response.json();
      if (!status || typeof status !== "object" || Array.isArray(status) || !status.gateway && !status.odom && !status.environment) throw new Error("Invalid status payload");
      atomoriRenderStatus(status);
    } catch (_) {
      failed = true;
      atomoriStatusFailed();
    } finally {
      clearTimeout(timeout); atomoriStatusBusy = false;
      setTimeout(pollStatus, document.hidden ? 2000 : failed ? 1000 : 500);
    }
  }
  pollStatus();
  // END_ATOMORI_STATUS_HISTORY_V1
