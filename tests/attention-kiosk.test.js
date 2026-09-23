const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The Attention Kiosk add-on turns webcam frames
// into ABST events. Everything that decides what gets logged is pure and runs
// here without a camera: head pose from the MediaPipe matrix, the per-visitor
// session state machine, and which tests and goals receive the events.

const attention = require(path.join(__dirname, '..', 'js', 'attention-kiosk.js'));

// Column-major 4x4 for a head turned `yaw` degrees about Y then tilted `pitch`
// degrees about X, the layout MediaPipe uses for facialTransformationMatrixes.
function poseMatrix(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
  const r = ry.map((row) => [0, 1, 2].map((c) => row.reduce((sum, v, k) => sum + v * rx[k][c], 0)));
  const data = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) data[col * 4 + row] = r[row][col];
  data[14] = -50; // translation, ignored
  data[15] = 1;
  return data;
}

const looking = { yaw: 0, pitch: 0, width: 0.2 };
const away = { yaw: 70, pitch: 0, width: 0.2 };
const far = { yaw: 0, pitch: 0, width: 0.03 };

// Feeds the same faces every `step` ms from `from` to `to` (inclusive).
function feed(tracker, faces, from, to, step = 150) {
  const events = [];
  for (let t = from; t <= to; t += step) events.push(...tracker.update(faces, t).map((e) => ({ ...e, t })));
  return events;
}

test('head pose reads yaw and pitch from the column-major transformation matrix', () => {
  const straight = attention.headPose(poseMatrix(0, 0));
  assert.ok(Math.abs(straight.yaw) < 1e-9 && Math.abs(straight.pitch) < 1e-9);

  assert.ok(Math.abs(Math.abs(attention.headPose(poseMatrix(30, 0)).yaw) - 30) < 1e-6);
  assert.ok(Math.abs(attention.headPose(poseMatrix(30, 0)).pitch) < 1e-6);
  assert.ok(Math.abs(Math.abs(attention.headPose(poseMatrix(0, 15)).pitch) - 15) < 1e-6);
  assert.ok(Math.abs(attention.headPose(poseMatrix(0, 15)).yaw) < 1e-6);

  // Turning the other way flips the sign, so a pitch offset can be calibrated.
  assert.ok(attention.headPose(poseMatrix(0, 15)).pitch * attention.headPose(poseMatrix(0, -15)).pitch < 0);
  assert.equal(attention.headPose([1, 2, 3]), null);
});

test('faces come out of a FaceLandmarker result with pose and width', () => {
  const faces = attention.facesFromResult({
    faceLandmarks: [[{ x: 0.4, y: 0.5 }, { x: 0.55, y: 0.4 }, { x: 0.45, y: 0.6 }], [{ x: 0.1, y: 0.1 }]],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: poseMatrix(10, 0) }],
  });
  // The second face has no matrix, so it has no pose and is dropped.
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].width - 0.15) < 1e-9);
  assert.ok(Math.abs(Math.abs(faces[0].yaw) - 10) < 1e-6);
  assert.deepEqual(attention.facesFromResult(null), []);
  assert.deepEqual(attention.facesFromResult({ faceLandmarks: [] }), []);
});

test('a passer-by who looks for the conversion time converts once', () => {
  const tracker = attention.createTracker({ conversionSeconds: 2 });
  const events = feed(tracker, [looking], 0, 4000);

  assert.deepEqual(events.map((e) => e.type), ['arrive', 'conversion']);
  assert.equal(events[0].t, 0);
  assert.ok(events[1].t >= 2000 && events[1].t < 2200, 'converts right after 2s of looking');
});

test('goals shorter than the conversion time fire on time without moving the conversion', () => {
  // 5s primary conversion with a goal every second up to 10s.
  const goalSeconds = [1, 2, 3, 4, 6, 7, 8, 9, 10];
  const tracker = attention.createTracker({ conversionSeconds: 5, goalSeconds });
  const events = feed(tracker, [looking], 0, 12000, 100).filter((e) => e.type !== 'arrive');

  const conversion = events.filter((e) => e.type === 'conversion');
  assert.equal(conversion.length, 1);
  assert.ok(conversion[0].t >= 5000 && conversion[0].t < 5100, 'converts at 5s, not at the first goal');
  assert.deepEqual(events.filter((e) => e.type === 'goal').map((e) => e.goal), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const e of events) assert.ok(e.t >= e.seconds * 1000 && e.t < e.seconds * 1000 + 100, `${e.type} ${e.seconds}s fires on time`);
  assert.deepEqual(events.map((e) => e.seconds), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'in time order');
});

test('goals keep the order they were configured in, whatever their times', () => {
  // Goal 0 is the test's first JavaScript Event sub goal even when it is the longest.
  const tracker = attention.createTracker({ conversionSeconds: 1, goalSeconds: [10, 2, 5] });
  const fired = feed(tracker, [looking], 0, 12000).filter((e) => e.type === 'goal');
  assert.deepEqual(fired.map((e) => [e.goal, e.seconds]), [[1, 2], [2, 5], [0, 10]]);
});

test('a goal at the same time as the conversion fires alongside it', () => {
  const tracker = attention.createTracker({ conversionSeconds: 3, goalSeconds: [3] });
  const events = feed(tracker, [looking], 0, 4000).filter((e) => e.type !== 'arrive');
  assert.deepEqual(events.map((e) => e.type), ['conversion', 'goal']);
  assert.equal(events[0].t, events[1].t);
});

test('walking past without looking is a visit with no conversion', () => {
  const tracker = attention.createTracker({ conversionSeconds: 2, leaveMs: 5000 });
  const events = [...feed(tracker, [away], 0, 6000), ...feed(tracker, [], 6150, 12000)];

  assert.deepEqual(events.map((e) => e.type), ['arrive', 'leave']);
  const leave = events[1];
  assert.equal(leave.converted, false);
  assert.equal(leave.goals, 0);
  assert.equal(leave.attentionMs, 0);
  assert.equal(leave.dwellMs, 6000);
  assert.ok(leave.t >= 11000, 'leaves only after 5s with nobody in view');
});

test('people too far from the screen are ignored', () => {
  const tracker = attention.createTracker({ conversionSeconds: 2, minFaceWidth: 0.08 });
  assert.deepEqual(feed(tracker, [far], 0, 5000), []);
});

test('brief detection dropouts do not reset attention, longer look-aways do not add to it', () => {
  const tracker = attention.createTracker({ conversionSeconds: 2, gapMs: 600 });
  // 1.5s looking, a 450ms dropout (one missed frame gap), then more looking.
  feed(tracker, [looking], 0, 1500);
  tracker.update([], 1950); // dropout frame, face still counted present
  const resumed = feed(tracker, [looking], 1950 + 0, 2600);
  assert.equal(resumed.filter((e) => e.type === 'conversion').length, 1, 'the dropout gap counts toward attention');

  const tracker2 = attention.createTracker({ conversionSeconds: 2, gapMs: 600 });
  feed(tracker2, [looking], 0, 1500); // 1.5s
  feed(tracker2, [away], 1650, 5000); // looking away: no attention added
  assert.equal(tracker2.snapshot().attentionMs, 1500);
  const second = feed(tracker2, [looking], 5150, 5900); // looks add up: 1.5 + 0.75
  assert.deepEqual(second.map((e) => e.type), ['conversion']);
});

test('a slow kiosk still accumulates attention between back-to-back frames', () => {
  // 800ms per frame is wider than the 600ms dropout window.
  const tracker = attention.createTracker({ conversionSeconds: 2, goalSeconds: [5], gapMs: 600 });
  const fired = feed(tracker, [looking], 0, 6400, 800).filter((e) => e.type !== 'arrive');
  assert.deepEqual(fired.map((e) => e.type), ['conversion', 'goal']);

  // A stalled tab adds at most maxStepMs for the gap.
  const stalled = attention.createTracker({ conversionSeconds: 10, maxStepMs: 1000 });
  stalled.update([looking], 0);
  stalled.update([looking], 30000);
  assert.equal(stalled.snapshot().attentionMs, 1000);
});

test('each goal fires once per visit', () => {
  const tracker = attention.createTracker({ conversionSeconds: 2, goalSeconds: [5, 10] });
  const fired = feed(tracker, [looking], 0, 30000).filter((e) => e.type !== 'arrive');
  assert.deepEqual(fired.map((e) => [e.type, e.seconds]), [['conversion', 2], ['goal', 5], ['goal', 10]]);
  assert.deepEqual(tracker.snapshot(), { present: true, attentionMs: 30000, converted: true, goals: 2 });
});

test('a group counts as one visitor and anyone looking counts for it', () => {
  const tracker = attention.createTracker({ conversionSeconds: 1 });
  const events = feed(tracker, [away, looking, far], 0, 1500);
  assert.deepEqual(events.map((e) => e.type), ['arrive', 'conversion']);
});

test('after someone leaves the next person starts a fresh session', () => {
  const tracker = attention.createTracker({ conversionSeconds: 1, goalSeconds: [1.2], leaveMs: 2000 });
  feed(tracker, [looking], 0, 1500);
  const gone = feed(tracker, [], 1650, 4000);
  assert.deepEqual(gone.map((e) => e.type), ['leave']);
  assert.equal(gone[0].converted, true);
  assert.equal(gone[0].goals, 1);
  assert.equal(gone[0].attentionMs, 1500);

  const next = feed(tracker, [looking], 10000, 11500);
  assert.deepEqual(next.map((e) => e.type), ['arrive', 'conversion', 'goal']);
});

test('pitch offset recentres the up/down window for a camera above the screen', () => {
  const lookingDown = { yaw: 0, pitch: -18, width: 0.2 };
  const plain = attention.createTracker({ maxPitch: 10 });
  const offset = attention.createTracker({ maxPitch: 10, pitchOffset: -15 });
  assert.equal(plain.isAttending(lookingDown), false);
  assert.equal(offset.isAttending(lookingDown), true);
  assert.equal(offset.isAttending(looking), false);
});

test('reports to running JavaScript-conversion tests unless test IDs are configured', () => {
  const experiments = {
    11: { conversion_page: 'javascript', test_status: 'publish' },
    12: { conversion_page: 'selector', test_status: 'publish' },
    13: { conversion_page: 'javascript', test_status: 'draft' },
    14: { conversion_page: 'javascript', test_status: 'publish' },
  };
  assert.deepEqual(attention.pickTargets(experiments, []), ['11', '14']);
  assert.deepEqual(attention.pickTargets(experiments, [12, 99]), ['12']);
  assert.deepEqual(attention.pickTargets(undefined, []), []);
});

test('goal numbers map to the JavaScript Event sub goals in goal order', () => {
  assert.deepEqual(
    attention.javascriptGoalIds({ goals: [null, { time: 30 }, { javascript: '' }, { selector: '.x' }, { javascript: '' }] }),
    ['2', '4']
  );
  assert.deepEqual(attention.javascriptGoalIds({ goals: { 3: { javascript: '' }, 1: { javascript: '' } } }), ['1', '3']);
  assert.deepEqual(attention.javascriptGoalIds({ goals: '{"2":{"javascript":""}}' }), ['2']);
  assert.deepEqual(attention.javascriptGoalIds({ goals: '' }), []);
  assert.deepEqual(attention.javascriptGoalIds(undefined), []);
});

test('the visitor reset clears exactly what abstForgetMe clears', () => {
  const names = attention.visitorStorageNames(
    'btab_11={"variation":"a"}; other=1; ab-advanced-id=abc; absttimer={}',
    ['btab_14', 'abst_attention_kiosk', 'ab-uuid'],
    ['ab-advanced-id', 'abst_attention_debug']
  );
  assert.deepEqual(names.sort(), ['ab-advanced-id', 'absttimer', 'btab_11', 'btab_14']);
});

test('seconds-looking mode values a qualifying visit at its total seconds', () => {
  assert.equal(attention.leaveConversionValue({ attentionMs: 12345 }, 5), 12.3);
  assert.equal(attention.leaveConversionValue({ attentionMs: 5000 }, 5), 5);
  assert.equal(attention.leaveConversionValue({ attentionMs: 4999 }, 5), null, 'short looks do not convert');
  assert.equal(attention.leaveConversionValue({ attentionMs: 0 }, 5), null);
  assert.equal(attention.leaveConversionValue(null, 5), null);
});

test('the QR link carries the visitor ID to a web page only', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(attention.qrUrl('https://shop.test/offer/', uuid, 'https://kiosk.test/'), `https://shop.test/offer/?abst_scan=${uuid}`);
  assert.equal(attention.qrUrl('/offer/?ref=kiosk', uuid, 'https://kiosk.test/screen/'), `https://kiosk.test/offer/?ref=kiosk&abst_scan=${uuid}`);
  assert.equal(attention.qrUrl('https://shop.test/offer/', '', 'https://kiosk.test/'), 'https://shop.test/offer/', 'no ID: plain link');
  assert.equal(attention.qrUrl('javascript:alert(1)', uuid, 'https://kiosk.test/'), '');
  assert.equal(attention.qrUrl('', uuid, 'not a url'), '');
});
