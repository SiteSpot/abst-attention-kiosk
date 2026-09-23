/**
 * AB Split Test — Attention Kiosk add-on.
 *
 * Turns an enrolled kiosk screen into an attention test: the webcam watches for
 * faces (on the device, nothing leaves the browser but the ABST events) and
 *
 *   - someone walking into range        = the visitor for the variation on screen
 *   - that person looking at the screen = the test's JavaScript conversion
 *                                         (or, in "seconds looking" mode, a
 *                                         conversion worth their seconds looking)
 *   - looking for other times           = the test's JavaScript Event sub goals
 *   - scanning the kiosk's QR code      = the phone takes over the visitor's
 *                                         assignment (see the PHP handoff)
 *   - everyone gone for a few seconds   = forget the visitor and reload, so the
 *                                         next passer-by gets a fresh assignment
 *
 * Only devices enrolled with ?abst_kiosk=<key> ever touch the camera.
 */
(function (root) {
  'use strict';

  var ENROLL_KEY = 'abst_attention_kiosk';
  var DEBUG_KEY = 'abst_attention_debug';

  // ---------------------------------------------------------------------------
  // Pure logic (no DOM, no camera) — exported for tests.
  // ---------------------------------------------------------------------------

  // Head yaw/pitch in degrees from a MediaPipe facial transformation matrix.
  // MediaPipe packs the 4x4 matrix column-major, so the third column — the
  // face's forward axis in camera space — is data[8..10]. Facing the camera
  // straight on gives (0, 0, 1) and yaw = pitch = 0.
  function headPose(matrixData) {
    if (!matrixData || matrixData.length < 11) return null;
    var fx = matrixData[8], fy = matrixData[9], fz = matrixData[10];
    var deg = 180 / Math.PI;
    return {
      yaw: Math.atan2(fx, fz) * deg,
      pitch: Math.atan2(fy, Math.sqrt(fx * fx + fz * fz)) * deg
    };
  }

  // Width of the face as a fraction of the frame, from normalized landmarks.
  function faceWidth(landmarks) {
    if (!landmarks || !landmarks.length) return 0;
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < landmarks.length; i++) {
      if (landmarks[i].x < min) min = landmarks[i].x;
      if (landmarks[i].x > max) max = landmarks[i].x;
    }
    return max - min;
  }

  // FaceLandmarker result -> [{ yaw, pitch, width }].
  function facesFromResult(result) {
    var faces = [];
    if (!result || !result.faceLandmarks) return faces;
    var matrices = result.facialTransformationMatrixes || [];
    for (var i = 0; i < result.faceLandmarks.length; i++) {
      var pose = headPose(matrices[i] && matrices[i].data);
      if (!pose) continue;
      faces.push({ yaw: pose.yaw, pitch: pose.pitch, width: faceWidth(result.faceLandmarks[i]) });
    }
    return faces;
  }

  function isAttending(face, opts) {
    return Math.abs(face.yaw) <= opts.maxYaw &&
      Math.abs(face.pitch - opts.pitchOffset) <= opts.maxPitch;
  }

  /**
   * Session state machine. Feed it the faces seen in each frame and it returns
   * the events that frame produced:
   *
   *   { type: 'arrive' }
   *   { type: 'conversion', seconds }        after conversionSeconds of looking
   *   { type: 'goal', goal, seconds }        goal = index into goalSeconds
   *   { type: 'leave', dwellMs, attentionMs, converted, goals }
   *
   * The conversion and each goal have their own threshold and fire once per
   * session, in whatever order the thresholds are reached.
   *
   * Attention time is cumulative per session: consecutive attending frames add
   * the time between them, so detection flicker shorter than gapMs does not
   * reset anything, and several short looks add up. Back-to-back attending
   * frames always count (up to maxStepMs), so a slow kiosk that only manages a
   * couple of frames a second still accumulates.
   */
  function createTracker(options) {
    var opts = {
      conversionSeconds: 2,
      goalSeconds: [],       // goal i fires after goalSeconds[i] of looking
      maxYaw: 25,
      maxPitch: 20,
      pitchOffset: 0,
      minFaceWidth: 0.08,
      leaveMs: 5000,
      gapMs: 600,
      maxStepMs: 1000
    };
    for (var k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k) && options[k] !== undefined) opts[k] = options[k];
    }
    opts.goalSeconds = (opts.goalSeconds || []).slice();

    var state;
    function reset() {
      state = { present: false, arrivedAt: 0, lastSeenAt: 0, lastFrameAt: null, lastAttendAt: null, attentionMs: 0, converted: false, goals: [] };
    }
    reset();

    function update(faces, now) {
      var events = [];
      var near = (faces || []).filter(function (f) { return f.width >= opts.minFaceWidth; });
      var attending = near.some(function (f) { return isAttending(f, opts); });

      if (near.length) {
        if (!state.present) {
          state.present = true;
          state.arrivedAt = now;
          events.push({ type: 'arrive' });
        }
        state.lastSeenAt = now;
      }

      if (attending) {
        var sinceLook = state.lastAttendAt === null ? null : now - state.lastAttendAt;
        if (sinceLook !== null && (sinceLook <= opts.gapMs || state.lastAttendAt === state.lastFrameAt)) {
          state.attentionMs += Math.min(sinceLook, opts.maxStepMs);
        }
        state.lastAttendAt = now;
        var due = [];
        if (!state.converted && state.attentionMs >= opts.conversionSeconds * 1000) {
          state.converted = true;
          due.push({ type: 'conversion', seconds: opts.conversionSeconds });
        }
        opts.goalSeconds.forEach(function (seconds, goal) {
          if (state.goals.indexOf(goal) === -1 && state.attentionMs >= seconds * 1000) {
            state.goals.push(goal);
            due.push({ type: 'goal', goal: goal, seconds: seconds });
          }
        });
        // Several thresholds crossed in one frame still fire shortest first.
        events.push.apply(events, due.sort(function (a, b) { return a.seconds - b.seconds; }));
      }

      if (state.present && !near.length && now - state.lastSeenAt >= opts.leaveMs) {
        events.push({
          type: 'leave',
          dwellMs: state.lastSeenAt - state.arrivedAt,
          attentionMs: state.attentionMs,
          converted: state.converted,
          goals: state.goals.length
        });
        reset();
      }

      state.lastFrameAt = now;
      return events;
    }

    return {
      update: update,
      snapshot: function () {
        return { present: state.present, attentionMs: state.attentionMs, converted: state.converted, goals: state.goals.length };
      },
      isAttending: function (face) { return isAttending(face, opts); },
      options: opts
    };
  }

  // Tests on this page the kiosk should report to: the configured IDs, or every
  // running test whose primary conversion is "JavaScript".
  function pickTargets(experiments, testIds) {
    var ids = Object.keys(experiments || {});
    if (testIds && testIds.length) {
      var wanted = testIds.map(String);
      return ids.filter(function (id) { return wanted.indexOf(id) !== -1; });
    }
    return ids.filter(function (id) {
      var exp = experiments[id];
      return exp && exp.conversion_page === 'javascript' && exp.test_status === 'publish';
    });
  }

  // IDs of a test's "JavaScript Event" sub goals, in goal order.
  function javascriptGoalIds(experiment) {
    var goals = experiment && experiment.goals;
    if (typeof goals === 'string') {
      try { goals = JSON.parse(goals); } catch (e) { goals = null; }
    }
    if (!goals || typeof goals !== 'object') return [];
    return Object.keys(goals)
      .filter(function (id) {
        var goal = goals[id];
        return goal && typeof goal === 'object' && Object.keys(goal)[0] === 'javascript';
      })
      .sort(function (a, b) { return Number(a) - Number(b); });
  }

  // Storage names that make ABST treat this browser as a returning visitor.
  // Mirrors abstForgetMe() in js/bt_conversion.js.
  function visitorStorageNames(cookieString, localKeys, sessionKeys) {
    var names = {};
    function consider(name) {
      name = (name || '').trim();
      if (name.indexOf('btab_') === 0 || name === 'ab-advanced-id' || name === 'absttimer') names[name] = true;
    }
    (cookieString || '').split(';').forEach(function (c) { consider(c.split('=')[0]); });
    (localKeys || []).forEach(consider);
    (sessionKeys || []).forEach(consider);
    return Object.keys(names);
  }

  // "Seconds looking" conversion mode: a visit that reached the conversion time
  // converts when the person leaves, valued at their total seconds looking, so
  // the test's order-value report reads as average attention per passer-by.
  function leaveConversionValue(leave, conversionSeconds) {
    if (!leave || leave.attentionMs < conversionSeconds * 1000) return null;
    return Math.round(leave.attentionMs / 100) / 10;
  }

  // The link the kiosk's QR code opens: the configured page, tagged with this
  // visitor's advanced-tracking UUID so the phone can take over the assignment.
  function qrUrl(base, uuid, pageUrl) {
    var url;
    try { url = new URL(base, pageUrl); } catch (e) { return ''; }
    if (!/^https?:$/.test(url.protocol)) return '';
    if (uuid) url.searchParams.set('abst_scan', uuid);
    return url.toString();
  }

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  var api = {
    headPose: headPose,
    faceWidth: faceWidth,
    facesFromResult: facesFromResult,
    createTracker: createTracker,
    pickTargets: pickTargets,
    javascriptGoalIds: javascriptGoalIds,
    visitorStorageNames: visitorStorageNames,
    leaveConversionValue: leaveConversionValue,
    qrUrl: qrUrl
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (!root || !root.document) return;
  root.ABSTAttention = api;

  // ---------------------------------------------------------------------------
  // Browser runtime.
  // ---------------------------------------------------------------------------

  var cfg = root.ABST_ATTENTION || {};
  var doc = root.document;

  function log() {
    if (typeof root.abLog === 'function') {
      root.abLog.apply(null, ['ABST attention:'].concat([].slice.call(arguments)));
    }
  }

  function storageGet(store, key) {
    try { return root[store].getItem(key); } catch (e) { return null; }
  }
  function storageSet(store, key, value) {
    try { root[store].setItem(key, value); } catch (e) { }
  }
  function storageRemove(store, key) {
    try { root[store].removeItem(key); } catch (e) { }
  }

  function sha256(text) {
    return root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(hex);
  }

  // ?abst_kiosk=<key> enrolls this device, ?abst_kiosk=off un-enrolls it,
  // ?abst_kiosk_debug=1|0 toggles the calibration overlay for this tab.
  function handleEnrollment() {
    var url = new URL(root.location.href);
    var param = url.searchParams.get('abst_kiosk');
    var debugParam = url.searchParams.get('abst_kiosk_debug');
    var pending = Promise.resolve();

    if (debugParam !== null) {
      if (debugParam === '0') storageRemove('sessionStorage', DEBUG_KEY);
      else storageSet('sessionStorage', DEBUG_KEY, '1');
      url.searchParams.delete('abst_kiosk_debug');
    }

    if (param !== null) {
      url.searchParams.delete('abst_kiosk');
      if (param === 'off') {
        storageRemove('localStorage', ENROLL_KEY);
      } else if (root.crypto && root.crypto.subtle) {
        pending = sha256(param).then(function (hash) {
          if (hash === cfg.keyHash) storageSet('localStorage', ENROLL_KEY, hash);
          else console.warn('ABST attention: that kiosk key does not match this site.');
        });
      }
    }

    if (param !== null || debugParam !== null) {
      try { root.history.replaceState(null, '', url.toString()); } catch (e) { }
    }
    return pending;
  }

  // Rotating the key in the admin un-enrolls every kiosk.
  function isEnrolled() {
    return !!cfg.keyHash && storageGet('localStorage', ENROLL_KEY) === cfg.keyHash;
  }

  function whenTestsReady() {
    return new Promise(function (resolve) {
      if (doc.body && doc.body.classList.contains('ab-test-setup-complete')) return resolve();
      doc.addEventListener('ab-test-setup-complete', function () { resolve(); }, { once: true });
    });
  }

  function emit(detail) {
    try { doc.dispatchEvent(new CustomEvent('abst-attention', { detail: detail })); } catch (e) { }
  }

  // Forget the visitor, then reload so ABST assigns (and logs a visit for) a
  // fresh variation before the next person walks up.
  function resetVisitor() {
    var localKeys = [], sessionKeys = [];
    try { localKeys = Object.keys(root.localStorage); } catch (e) { }
    try { sessionKeys = Object.keys(root.sessionStorage); } catch (e) { }
    visitorStorageNames(doc.cookie, localKeys, sessionKeys).forEach(function (name) {
      if (typeof root.abstDeleteCookie === 'function') {
        root.abstDeleteCookie(name);
      } else {
        doc.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; path=/';
        storageRemove('localStorage', name);
        storageRemove('sessionStorage', name);
      }
    });
    root.location.reload();
  }

  function convert(targets, value) {
    if (typeof root.abstConvert !== 'function') return;
    // abstConvert() treats a value of exactly 1 as "look the order value up on
    // the page"; the custom value it checks first keeps it at seconds looking.
    if (value !== undefined && root.abst) root.abst.abConversionValue = value;
    targets.forEach(function (eid) {
      if (value === undefined) root.abstConvert(eid);
      else root.abstConvert(eid, value);
    });
  }

  function report(event, targets) {
    if (event.type === 'conversion' && !cfg.conversionValue) convert(targets);
    if (event.type === 'leave' && cfg.conversionValue) {
      var value = leaveConversionValue(event, cfg.conversionSeconds);
      if (value !== null) convert(targets, value);
    }
    if (event.type === 'goal' && typeof root.abstGoal === 'function') {
      targets.forEach(function (eid) {
        var goalId = javascriptGoalIds(root.bt_experiments[eid])[event.goal];
        if (goalId !== undefined) root.abstGoal(eid, goalId);
      });
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      doc.head.appendChild(s);
    });
  }

  function drawQr(link, size) {
    var qr = root.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 2;
    // Drawn at whole pixels per module, then shown at exactly the set size.
    var cell = Math.max(2, Math.ceil(size / (count + quiet * 2)));
    var canvas = doc.createElement('canvas');
    canvas.width = canvas.height = cell * (count + quiet * 2);
    canvas.style.width = canvas.style.height = size + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    canvas.className = 'abst-kiosk-qr-code';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR code');
    return canvas;
  }

  // Draws this visitor's QR code into every .abst-kiosk-qr element the page
  // has (so each design can place it), or a corner badge when there are none.
  function showQr(debugLine) {
    if (!cfg.qrUrl) return;
    var uuid = cfg.advancedTracking && typeof root.abstGetAdvancedId === 'function' ? root.abstGetAdvancedId() : '';
    if (!uuid) debugLine('qr        no visitor ID: enable Advanced Tracking (UUID) in AB Split Test settings to credit scans');
    var link = qrUrl(cfg.qrUrl, uuid, root.location.href);
    if (!link) return debugLine('qr        the QR code link is not a web address');

    loadScript(cfg.qrLibraryUrl).then(function () {
      var slots = [].slice.call(doc.querySelectorAll('.abst-kiosk-qr'));
      if (!slots.length) {
        var badge = doc.createElement('div');
        badge.className = 'abst-kiosk-qr abst-kiosk-qr-badge';
        doc.body.appendChild(badge);
        slots = [badge];
      }
      slots.forEach(function (slot) {
        slot.textContent = '';
        slot.appendChild(drawQr(link, cfg.qrSize || 160));
        if (cfg.qrLabel) {
          var label = doc.createElement('div');
          label.className = 'abst-kiosk-qr-label';
          label.textContent = cfg.qrLabel;
          slot.appendChild(label);
        }
      });
      log('QR code', link);
    }).catch(function (error) {
      console.error('ABST attention: could not draw the QR code', error);
    });
  }

  function createOverlay(debug) {
    var box = doc.createElement('div');
    box.className = 'abst-attention-overlay' + (debug ? ' is-debug' : '');
    box.setAttribute('aria-live', 'polite');
    var notice = doc.createElement('div');
    notice.className = 'abst-attention-notice';
    notice.textContent = cfg.noticeText || '';
    box.appendChild(notice);
    var stats = doc.createElement('pre');
    stats.className = 'abst-attention-stats';
    box.appendChild(stats);
    return { box: box, notice: notice, stats: stats };
  }

  function injectStyles() {
    var style = doc.createElement('style');
    style.textContent =
      '.abst-attention-overlay{position:fixed;right:12px;bottom:12px;z-index:2147483646;font:12px/1.4 system-ui,sans-serif;color:#fff;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
      '.abst-attention-overlay.is-debug{background:rgba(220,53,69,.6);border-radius:8px;padding:4px}' +
      '.abst-attention-overlay.is-debug.is-attending{background:rgba(46,204,113,.6)}' +
      '.abst-attention-notice{background:rgba(0,0,0,.6);padding:6px 10px;border-radius:14px}' +
      '.abst-attention-notice:empty,.abst-attention-stats:empty{display:none}' +
      '.abst-attention-overlay video{display:none}' +
      '.abst-attention-overlay.is-debug video{display:block;width:240px;border-radius:8px;transform:scaleX(-1);border:3px solid #888}' +
      '.abst-attention-overlay.is-attending video{border-color:#2ecc71}' +
      '.abst-kiosk-qr-badge{position:fixed;left:12px;bottom:12px;z-index:2147483645;background:#fff;padding:8px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.25)}' +
      '.abst-kiosk-qr-code{display:block;image-rendering:pixelated}' +
      '.abst-kiosk-qr-label{margin-top:6px;text-align:center;font:600 14px/1.3 system-ui,sans-serif;color:#111}' +
      '.abst-attention-stats{margin:0;background:rgba(0,0,0,.75);padding:8px 10px;border-radius:8px;white-space:pre;font:11px/1.4 ui-monospace,monospace}';
    doc.head.appendChild(style);
  }

  function loadLandmarker() {
    return import(cfg.visionBundleUrl).then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(cfg.wasmUrl).then(function (fileset) {
        function create(delegate) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: cfg.modelUrl, delegate: delegate },
            runningMode: 'VIDEO',
            numFaces: cfg.maxFaces || 3,
            outputFacialTransformationMatrixes: true
          });
        }
        return create('GPU').catch(function () { return create('CPU'); });
      });
    });
  }

  function fmt(n) { return (n >= 0 ? '+' : '') + n.toFixed(0) + '°'; }

  function start() {
    var debug = !!cfg.debug || storageGet('sessionStorage', DEBUG_KEY) === '1';
    var targets = pickTargets(root.bt_experiments, cfg.testIds);
    injectStyles();
    var overlay = createOverlay(debug);
    if (!cfg.showNotice) overlay.notice.textContent = '';
    doc.body.appendChild(overlay.box);

    var notes = [];
    function note(line) {
      notes.push(line);
      console.warn('ABST attention: ' + line.replace(/^\w+\s+/, ''));
    }
    if (!targets.length) {
      console.warn('ABST attention: no running test on this page uses a JavaScript conversion, so nothing will be recorded.');
    }
    showQr(note);
    if (!root.isSecureContext || !root.navigator.mediaDevices) {
      overlay.stats.textContent = 'Attention kiosk: the camera needs HTTPS.';
      return;
    }

    var video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    overlay.box.insertBefore(video, overlay.stats);

    var tracker = createTracker({
      conversionSeconds: cfg.conversionSeconds,
      goalSeconds: cfg.goalSeconds,
      maxYaw: cfg.maxYaw,
      maxPitch: cfg.maxPitch,
      pitchOffset: cfg.pitchOffset,
      minFaceWidth: cfg.minFaceWidth,
      leaveMs: cfg.leaveSeconds * 1000
    });
    var sessions = 0;
    var reloading = false;

    root.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then(function (stream) {
        video.srcObject = stream;
        return Promise.all([loadLandmarker(), video.play()]);
      })
      .then(function (loaded) {
        var landmarker = loaded[0];
        var lastVideoTime = -1;
        var fps = 0, lastFrameAt = 0;
        log('running for tests', targets);

        setInterval(function () {
          if (reloading || video.readyState < 2 || video.currentTime === lastVideoTime) return;
          lastVideoTime = video.currentTime;
          var now = root.performance.now();
          if (lastFrameAt) fps = fps * 0.8 + (1000 / (now - lastFrameAt)) * 0.2;
          lastFrameAt = now;
          var faces = facesFromResult(landmarker.detectForVideo(video, now));

          tracker.update(faces, now).forEach(function (event) {
            emit(event);
            log(event);
            if (event.type === 'arrive') sessions++;
            report(event, targets);
            if (event.type === 'leave' && cfg.reloadOnLeave) {
              // Let a just-fired conversion request get out before reloading.
              reloading = true;
              setTimeout(resetVisitor, 1000);
            }
          });

          var attending = faces.some(function (f) { return f.width >= tracker.options.minFaceWidth && tracker.isAttending(f); });
          overlay.box.classList.toggle('is-attending', attending);
          if (debug) {
            var snap = tracker.snapshot();
            overlay.stats.textContent = [
              'tests     ' + (targets.join(', ') || 'none (set conversion to JavaScript)'),
              'faces     ' + faces.map(function (f) {
                return 'yaw ' + fmt(f.yaw) + ' pitch ' + fmt(f.pitch) + ' width ' + Math.round(f.width * 100) + '%';
              }).join('\n          '),
              'present   ' + (snap.present ? 'yes' : 'no') + (attending ? ' · LOOKING' : ''),
              'attention ' + (snap.attentionMs / 1000).toFixed(1) + 's · ' + (cfg.conversionValue
                ? (snap.converted ? 'will convert on leave' : 'converts on leave after ' + tracker.options.conversionSeconds + 's')
                : (snap.converted ? 'converted' : 'converts at ' + tracker.options.conversionSeconds + 's')) +
                ' · goals ' + snap.goals + '/' + tracker.options.goalSeconds.length,
              'sessions  ' + sessions + ' this page load · ' + fps.toFixed(1) + ' fps'
            ].concat(notes).join('\n');
          }
        }, cfg.frameIntervalMs || 150);
      })
      .catch(function (error) {
        console.error('ABST attention: could not start the camera or face model', error);
        overlay.stats.textContent = 'Attention kiosk: ' + (error && error.message ? error.message : 'camera unavailable');
      });
  }

  handleEnrollment().then(function () {
    if (!isEnrolled()) return;
    return whenTestsReady().then(start);
  });
})(typeof window !== 'undefined' ? window : null);
