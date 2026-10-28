  // Reuse the status poll; retain the last valid map marker only for display.
  function pollRobotPose(status) {
    var loc = status && status.localization || {};
    var valid = !!status && atomoriFresh(loc.age_s, 2) && Array.isArray(loc.map_pose) && loc.map_pose.length === 3 && loc.map_pose.every(Number.isFinite);
    if (valid) {
      robotMapPose = loc.map_pose;
      robotLocalizationConfidence = loc.confidence || "none";
      renderLocalization(loc);
      atomoriReading("localizationState", localizationStateEl.textContent, true, loc.age_s);
      atomoriReading("localizationPose", localizationPoseEl.textContent, true, loc.age_s);
      localizationPoseEl.style.color = ""; localizationPoseEl.title = "";
    } else {
      atomoriPaint("localizationState", atomoriReading("localizationState", "", false, null));
      atomoriPaint("localizationPose", atomoriReading("localizationPose", "", false, null));
      localizationHintEl.textContent = robotMapPose ? "最近有效位置；当前未获得有效定位" : "等待有效定位";
      robotLocalizationConfidence = "none";
    }
    if (navMapData) drawNavMap();
  }
