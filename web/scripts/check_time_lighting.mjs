// Optional browser acceptance for time lighting and experimental display grading.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  output: {type: 'string'}, playwright: {type: 'string'}, browser: {type: 'string'}, rooms: {type: 'string', default: 'room3,office'}}});
if (!values.output) throw new Error('请指定仓库外的 --output 结果目录');
const output = resolve(values.output), repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
if (output === repo || output.startsWith(repo + '/')) throw new Error('私人房间截图不能写入仓库');
await mkdir(output, {recursive: true});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
const report = {recordedAt: new Date().toISOString(), rooms: []};
const save = async (name, data) => writeFile(join(output, name), Buffer.from(data.split(',')[1], 'base64'));
const waitFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settled = async page => {
  await waitFrame(page);
  await page.waitForFunction(() => {
    if (window.roomEditorError) throw new Error(window.roomEditorError);
    return window.roomEditor?.snapshot().lighting.state === 'settled';
  }, null, {timeout: 180000});
};
try {
  const fixture = await browser.newPage();
  await fixture.route('**/__time_light_fixture__.html', route => route.fulfill({contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">' + JSON.stringify({imports: {
      three: new URL('vendor/build/three.module.js', values.url).href,
      'three/addons/': new URL('vendor/examples/jsm/', values.url).href,
    }}) + '</script>'}));
  await fixture.goto(new URL('__time_light_fixture__.html', values.url).href);
  report.attenuation = await fixture.evaluate(async base => {
    const THREE = await import('three');
    const {createTimeLighting} = await import(new URL('editor/time-lighting.mjs', base));
    const {createLightingComposite} = await import(new URL('editor/lighting-composite.mjs', base));
    const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    renderer.setSize(400, 400); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#252b34');
    scene.add(new THREE.HemisphereLight(), new THREE.DirectionalLight(), new THREE.DirectionalLight());
    const room = new THREE.Group(); scene.add(room);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({color: 0xaaaaaa, roughness: 1}));
    plane.rotation.x = -Math.PI / 2; room.add(plane); room.updateMatrixWorld(true);
    const rig = createTimeLighting(THREE, {renderer, scene, room, config: {openings: {}, isCeiling: () => false, label: () => null}, walls: [],
      bounds: new THREE.Box3(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 3, 4)), floorY: 0, ceilingY: 3,
      profile: {key: 3, fill: .65, hemisphere: 1.1, environment: .35}});
    rig.apply('night');
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, .1, 30); camera.position.set(0, 10, .25); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
    const composite = createLightingComposite(renderer); composite.render(scene, camera);
    const gl = renderer.getContext();
    const sample = x => {const pixel = new Uint8Array(4); gl.readPixels(x, 200, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return [...pixel].slice(0, 3);};
    // Avoid the small visible emitter at the image centre; both probes are on the same flat floor.
    const near = sample(215), far = sample(345), image = renderer.domElement.toDataURL();
    const grades = {};
    for (const [key, value] of [['exposure', 1], ['whiteBalance', .8], ['contrast', 1.3], ['saturation', 0]]) {
      composite.setGrading({[key]: value}); composite.present(); grades[key] = {near: sample(215), far: sample(345)};
    }
    const light = rig.snapshot(), angles = {};
    for (const angle of [60, 100, 160, 170]) {
      rig.setIndoor({power: true, angle}); composite.setGrading({}); composite.render(scene, camera);
      angles[angle] = {near: sample(215), far: sample(345), image: renderer.domElement.toDataURL()};
    }
    const result = {near, far, image, light, grades, angles};
    composite.dispose(); rig.dispose(); renderer.dispose(); renderer.forceContextLoss();
    return result;
  }, values.url);
  assert.ok(report.attenuation.near.reduce((a, b) => a + b) > report.attenuation.far.reduce((a, b) => a + b) + 30, '夜间地面没有近亮远暗的像素变化');
  const pixels = report.attenuation, graded = pixels.grades;
  console.log('夜间地面像素：', JSON.stringify({near: pixels.near, far: pixels.far, narrowFar: pixels.angles[60].far, wideFar: pixels.angles[160].far}));
  assert.ok(graded.exposure.near.every((value, i) => value >= pixels.near[i]) && graded.exposure.near[0] > pixels.near[0], '增加 EV 未提高亮度');
  assert.ok(graded.whiteBalance.near[0] / graded.whiteBalance.near[2] > pixels.near[0] / pixels.near[2], '白平衡偏暖没有提高红蓝比例');
  assert.ok(graded.contrast.near[0] - graded.contrast.far[0] > pixels.near[0] - pixels.far[0], '对比度未扩大亮暗差');
  assert.ok(Math.max(...graded.saturation.near) - Math.min(...graded.saturation.near) <= 1, '饱和度 0 未变灰度');
  assert.ok(pixels.angles[160].far.reduce((a, b) => a + b) > pixels.angles[60].far.reduce((a, b) => a + b) + 30, '扩大光照角度没有照亮更远处的地面');
  await save('night-distance-fixture.png', report.attenuation.image); delete report.attenuation.image;
  for (const [angle, data] of Object.entries(pixels.angles)) {await save(`night-angle-${angle}-fixture.png`, data.image); delete data.image;}
  report.sashes = await fixture.evaluate(async base => {
    const THREE = await import('three'), {createNightWindow} = await import(new URL('editor/night-window.mjs', base));
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(96, 48);
    const scene = new THREE.Scene(), room = new THREE.Group(); scene.add(room);
    scene.background = new THREE.Color(0);
    const face = {n: [0, 0, 1]}, window = {face, position: new THREE.Vector3()};
    const probe = createNightWindow(THREE, {room, scene, window, center: new THREE.Vector3(0, 0, 2), diagonal: 6, revealRoot: () => false});
    const glass = new THREE.MeshPhysicalMaterial({transmission: 1, side: THREE.DoubleSide});
    const panes = [-.5, .5].map(x => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(.9, .9), glass);
      mesh.position.x = x; room.add(mesh);
      mesh.material = probe.material(glass, 0, probe.onMainWall(mesh, face));
      return mesh;
    });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide}));
    wall.position.z = 3; room.add(wall); probe.power(true);
    const camera = new THREE.OrthographicCamera(-1, 1, .5, -.5, .1, 5);
    camera.position.z = 2;
    const gl = renderer.getContext(), pixel = new Uint8Array(4);
    function sample() {
      renderer.render(scene, camera);
      return [24, 72].map(x => {gl.readPixels(x, 24, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return pixel[0];});
    }
    const closed = sample(); panes[0].rotation.y = Math.PI / 3;
    const open = sample();
    camera.position.set(Math.sqrt(3) * 1.5, 0, 1.5); camera.lookAt(0, 0, 0);
    camera.left = -.5; camera.right = .5; camera.updateProjectionMatrix();
    panes[0].rotation.y = 0; const grazing = sample();
    panes[0].rotation.y = Math.PI / 6; const turned = sample();
    const captures = probe.snapshot().captures;
    probe.dispose(); renderer.dispose();
    return {closed, open, grazing, turned, captures};
  }, values.url);
  const {closed, open, grazing, turned, captures} = report.sashes;
  assert.ok(closed[0] > 0 && closed[0] === closed[1]);
  assert.deepEqual(open, [0, closed[1]], '打开的窗扇反射方向转出室内，邻扇应保留原倒影');
  assert.ok(turned[0] > 0 && turned[0] < grazing[0], '转向相机的窗扇应降低菲涅耳反射强度');
  assert.equal(turned[1], grazing[1]);
  assert.equal(captures, 1);
  await fixture.close();
  for (const room of values.rooms.split(',').filter(Boolean)) {
    console.log('检查时段和调色：' + room);
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.route('**/viewforge/**', route => route.fulfill({json: {runs: []}}));
    await page.goto(new URL(`editor/?room=${room}&lightingLab=1`, values.url).href);
    await settled(page);
    const setTime = async time => {
      if (!await page.locator('#light-menu').evaluate(element => element.open)) await page.click('#light');
      await page.locator(`[name="lighting-time-choice"][value="${time}"]`).check();
      await settled(page);
    };
    const setAngle = async angle => {
      await page.locator('#lamp-angle').evaluate((element, value) => {element.value = value; element.dispatchEvent(new Event('input', {bubbles: true}));}, angle);
      await settled(page);
    };
    const sliders = page.locator('#lighting-menu input[type=range]');
    assert.equal(await sliders.count(), 4);
    assert.equal(await page.locator('#lighting-menu select').count(), 0);
    assert.equal(await page.locator('#light-menu #lighting-time').count(), 1);
    assert.deepEqual(await page.locator('#lighting-time option').allTextContents(), ['普通光照', '早晨', '中午', '下午', '夜间', '物理光照']);
    assert.equal(await page.locator('#light-menu input[type=checkbox]').count(), 0);
    assert.equal(await page.locator('#lamp-strip').count(), 0);
    assert.equal(await page.locator('#light-menu input[type=range]').count(), 1);
    for (const input of await sliders.all()) assert.equal(await input.isEnabled(), true);
    const result = {room, presets: [], grading: [], errors};
    for (const time of ['balanced', 'morning', 'noon', 'afternoon', 'night']) {
      await setTime(time);
      const light = await page.evaluate(() => roomEditor.snapshot().lighting);
      assert.equal(light.time.preset, time);
      assert.ok(light.time.lamp.visible, '室内灯应在每个时段均可使用');
      // Rooms with ceiling luminaires are lit from them; others from the central lamp.
      const fromLuminaires = light.time.luminaires.length > 0;
      assert.equal(light.time.lamp.source, fromLuminaires ? 'luminaire' : 'room-bounds-center');
      assert.ok(Math.abs(light.time.lamp.angle - 160) < 1e-6);
      const {position, roomBounds} = light.time.lamp;
      if (fromLuminaires) assert.deepEqual(position, light.time.lights[0].position);
      else for (const axis of [0, 2]) assert.equal(position[axis], (roomBounds.min[axis] + roomBounds.max[axis]) / 2);
      const nightShadows = light.time.lights.filter(lamp => lamp.shadowCandidate).length;
      assert.equal(light.lights.filter(light => light.visible && light.castShadow).length,
        ['morning', 'noon', 'afternoon'].includes(time) && light.time.window ? 2 : time === 'night' ? nightShadows : 1);
      if (time === 'night') {
        assert.equal(light.environment.intensity, .08);
        assert.equal(light.time.lamp.decay, 2);
        assert.ok(light.lights.filter(light => light.type === 'DirectionalLight').every(light => light.intensity === 0 && !light.visible));
      } else if (time !== 'balanced') {
        assert.equal(light.time.lamp.level, .25);
        assert.ok(light.time.windowLight.visible && light.time.windowLight.intensity > 0);
      }
      const image = await page.evaluate(() => roomEditor.captureFrame()); await save(`${room}-${time}.png`, image);
      result.presets.push({time, lighting: light});
    }
    result.indoor = [];
    for (const time of ['balanced', 'morning', 'noon', 'afternoon', 'night']) {
      await setTime(time);
      const outside = await page.evaluate(() => ({time: roomEditor.snapshot().lighting.time, lights: roomEditor.snapshot().lighting.lights.filter(light => !light.role?.startsWith('indoor'))}));
      const fixed = await page.evaluate(() => roomLightingLab.captureState());
      await setAngle(100);
      const narrow = await page.evaluate(() => roomEditor.captureFrame());
      await setAngle(160);
      const wide = await page.evaluate(() => roomEditor.captureFrame());
      assert.notEqual(narrow, wide, '照射角度没有改变实际画面');
      let state = await page.evaluate(() => roomEditor.snapshot().lighting.time);
      assert.equal(state.lamp.shadowFov, 160);
      const unchanged = await page.evaluate(() => roomLightingLab.captureState());
      assert.deepEqual(unchanged.camera, fixed.camera); assert.deepEqual(unchanged.layout, fixed.layout);
      if (time === 'night') {
        await save(`${room}-night-angle-100.png`, narrow); await save(`${room}-night-angle-160.png`, wide);
        for (const angle of [60, 170]) {await setAngle(angle); await save(`${room}-night-angle-${angle}.png`, await page.evaluate(() => roomEditor.captureFrame()));}
        await setAngle(160);
        assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.lights.filter(light => light.visible && light.castShadow).length),
          state.lights.filter(lamp => lamp.shadowCandidate).length);
      }
      await page.click('#lamp-power'); await settled(page);
      state = await page.evaluate(() => roomEditor.snapshot().lighting.time);
      assert.deepEqual(state.indoor, {power: false, angle: 160});
      assert.ok(!state.lamp.visible);
      assert.equal(await page.locator('#lamp-power').textContent(), '开灯');
      const fixedLights = lights => lights.filter(l => time !== 'night' || l.type !== 'HemisphereLight');
      assert.deepEqual(fixedLights(await page.evaluate(() => roomEditor.snapshot().lighting.lights.filter(light => !light.role?.startsWith('indoor')))), fixedLights(outside.lights), '室内开关改变了室外光照');
      assert.equal(state.environmentIntensity, time === 'night' ? 0 : outside.time.environmentIntensity);
      const off = await page.evaluate(() => roomEditor.captureFrame());
      assert.notEqual(off, wide, '关灯没有改变实际画面');
      if (time === 'night') await save(`${room}-night-lamps-off.png`, off);
      await setTime(time === 'night' ? 'morning' : 'night');
      assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.time.indoor.power), false, '切换时段重新开灯');
      await setTime(time);
      const offFrame = await page.evaluate(() => {roomLightingLab.resetMetrics(); return roomEditor.captureFrame();});
      await page.evaluate(() => roomLightingLab.resetMetrics());
      await setAngle(120);
      assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.time.lamp.visible), false, '调整角度绕过了开关');
      assert.equal(await page.evaluate(() => roomLightingLab.metrics().frames.length), 0, '关灯后调整角度仍重绘场景');
      assert.equal(await page.evaluate(() => roomEditor.captureFrame()), offFrame);
      await page.click('#lamp-power'); await settled(page);
      assert.deepEqual(await page.evaluate(() => roomEditor.snapshot().lighting.time.indoor), {power: true, angle: 120});
      await setAngle(160);
      result.indoor.push({time, angle: 160, power: true});
    }
    // Grade each control independently on a fixed frame. Only the fullscreen presentation
    // is allowed, without shadow/AO work, scene redraw or layout/camera changes.
    await setTime('balanced');
    await page.click('#lighting-menu > summary');
    assert.equal(await page.locator('#light-menu').evaluate(element => element.open), false);
    const baseline = await page.evaluate(() => ({frame: roomEditor.captureFrame(), state: roomLightingLab.captureState(), snapshot: roomEditor.snapshot()}));
    for (const [key, value] of [['exposure', 1], ['whiteBalance', .8], ['contrast', 1.3], ['saturation', 0]]) {
      await page.click('#grading-reset'); await waitFrame(page);
      await page.evaluate(() => roomLightingLab.resetMetrics());
      await page.locator(`[data-grade="${key}"]`).evaluate((element, value) => {element.value = value; element.dispatchEvent(new Event('input', {bubbles: true}));}, value);
      await waitFrame(page); await page.waitForTimeout(600);
      const check = await page.evaluate(() => ({metrics: roomLightingLab.metrics(), state: roomLightingLab.captureState(), snapshot: roomEditor.snapshot()}));
      assert.equal(check.snapshot.lighting.grading[key], value);
      assert.equal(check.snapshot.lighting.updates, baseline.snapshot.lighting.updates);
      assert.deepEqual(check.state.layout, baseline.state.layout); assert.deepEqual(check.state.camera, baseline.state.camera);
      assert.ok(check.metrics.frames.length > 0);
      assert.ok(check.metrics.frames.every(frame => frame.label === 'color-grade' && frame.calls === 1));
      const image = await page.evaluate(() => roomEditor.captureFrame()); assert.notEqual(image, baseline.frame, key + ' 没有改变画面');
      await save(`${room}-grade-${key}.png`, image);
      result.grading.push({key, value, frames: check.metrics.frames.length, calls: check.metrics.frames[0].calls, aoUpdates: check.snapshot.lighting.updates - baseline.snapshot.lighting.updates});
    }
    await page.click('#grading-reset'); await waitFrame(page);
    assert.equal(await page.evaluate(() => roomEditor.captureFrame()), baseline.frame, '重置调色未恢复原画面');
    // Native keyboard controls must adjust the slider without triggering furniture movement.
    await page.locator('#grade-exposure').focus(); await page.keyboard.press('ArrowRight'); await waitFrame(page);
    assert.equal(await page.locator('#grade-exposure').inputValue(), '0.05');
    await page.click('#grading-reset'); await waitFrame(page);
    // Repeated mode switches leave exactly one cached set of night emitters and one active shadow.
    for (const time of ['night', 'morning', 'night', 'balanced']) await setTime(time);
    assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.lights.filter(light => light.role === 'indoor').length),
      await page.evaluate(() => roomEditor.snapshot().lighting.time.lights.length));
    assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.lights.filter(light => light.role === 'outdoor-window').length), 1);
    assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.lights.filter(light => light.type === 'RectAreaLight').length),
      Math.min(6, await page.evaluate(() => roomEditor.snapshot().lighting.time.luminaires.length)));
    await page.locator('#light-menu').evaluate(element => {element.open = false;});
    await page.locator('#lighting-menu').evaluate(element => {element.open = false;});
    await page.evaluate(() => roomLightingLab.resetMetrics());
    const box = await page.locator('#viewport canvas').boundingBox();
    for (let i = 0; i < 15; i++) {await page.mouse.move(box.x + box.width * (i + .5) / 15, box.y + box.height * .6); await page.waitForTimeout(50);}
    await page.mouse.move(0, 0); await page.waitForTimeout(650);
    assert.equal((await page.evaluate(() => roomLightingLab.metrics())).frames.length, 0, '悬停导致重绘');
    // Save an actual panel screenshot, and check it remains reachable at a narrow viewport.
    await page.locator('#lighting-menu').evaluate(element => {element.open = true;});
    await page.screenshot({path: join(output, `${room}-panel.png`)});
    await page.setViewportSize({width: 390, height: 844}); await settled(page);
    await page.locator('#grade-saturation').scrollIntoViewIfNeeded();
    const range = await page.locator('#grade-saturation').boundingBox();
    assert.ok(range.x >= 0 && range.x + range.width <= 390 && range.y >= 0 && range.y + range.height <= 844);
    await page.screenshot({path: join(output, `${room}-mobile-panel.png`)});
    await page.click('#light');
    assert.equal(await page.locator('#lighting-menu').evaluate(element => element.open), false);
    const select = await page.locator('.rc-time-choices').boundingBox();
    assert.ok(select.x >= 0 && select.x + select.width <= 390 && select.y >= 0 && select.y + select.height <= 844);
    const power = await page.locator('#lamp-power').boundingBox();
    assert.ok(power.x >= 0 && power.x + power.width <= 390 && power.y >= 0 && power.y + power.height <= 844);
    const cone = await page.locator('#lamp-angle').boundingBox();
    assert.ok(cone.x >= 0 && cone.x + cone.width <= 390 && cone.y >= 0 && cone.y + cone.height <= 844);
    await page.locator('#lamp-angle').focus(); await page.keyboard.press('ArrowLeft'); await settled(page);
    assert.equal(await page.locator('#lamp-angle').inputValue(), '159');
    await page.screenshot({path: join(output, `${room}-mobile-time-panel.png`)});
    // The room remembers angle/power independently of time, grading and other rooms.
    await setAngle(125); await page.click('#lamp-power'); await settled(page);
    const remembered = {power: false, angle: 125};
    const other = await page.context().newPage();
    await other.route('**/viewforge/**', route => route.fulfill({json: {runs: []}}));
    const otherRoom = room === 'room3' ? 'office' : 'room3';
    await other.goto(new URL(`editor/?room=${otherRoom}`, values.url).href); await settled(other);
    assert.deepEqual(await other.evaluate(() => roomEditor.snapshot().lighting.time.indoor), {power: true, angle: 160}, '一个房间的灯具设置影响了另一个房间');
    await other.close(); await page.reload(); await settled(page);
    assert.deepEqual(await page.evaluate(() => roomEditor.snapshot().lighting.time.indoor), remembered);
    assert.equal(await page.locator('#lamp-angle').inputValue(), '125');
    assert.equal(await page.locator('#lamp-power').textContent(), '开灯');
    assert.deepEqual(errors, []); report.rooms.push(result);
    await context.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  const page = await browser.newPage();
  await page.route('**/viewforge/**', route => route.fulfill({json: {runs: []}}));
  await page.goto(new URL('editor/?room=office&lighting=off&time=night', values.url).href);
  await page.waitForFunction(() => window.roomEditor?.ready);
  assert.equal(await page.locator('#lighting-time').isDisabled(), true);
  assert.equal(await page.locator('#grade-exposure').isDisabled(), true);
  assert.equal(await page.locator('#lamp-power').isDisabled(), true);
  assert.equal(await page.locator('#lamp-angle').isDisabled(), true);
  await page.route('**/static-lighting.mjs*', route => route.abort());
  await page.goto(new URL('editor/?room=office&time=night', values.url).href);
  await page.waitForFunction(() => window.roomEditor?.snapshot().lighting.state === 'error', null, {timeout: 120000});
  assert.equal(await page.evaluate(() => window.roomEditorError), undefined);
  assert.equal(await page.locator('#grade-exposure').isDisabled(), true);
  assert.equal(await page.locator('#lighting-time').isEnabled(), true);
  assert.equal(await page.evaluate(() => roomEditor.snapshot().lighting.time.preset), 'night');
  await page.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
} finally {await browser.close();}
console.log(`通过：夜间衰减、调色像素及回退；${report.rooms.length} 个房间完成预设／滑条／单次合成／重置／空闲／窄屏验收。结果 ${output}`);
