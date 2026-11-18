// Real Chrome/WebGL regression: repeated draft replacement, animation and late asynchronous work.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  output: {type: 'string'}, playwright: {type: 'string'}, browser: {type: 'string'}}});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
const watchdog = setTimeout(() => {console.error('Replay resource validation timed out'); void browser.close();}, 60000);
try {
  const page = await browser.newPage({viewport: {width: 480, height: 360}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.text().startsWith('replay-check:')) console.error(message.text());
  });
  await page.route('**/__replay_resources__.html', route => route.fulfill({contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><style>html,body,#view{margin:0;width:100%;height:100%}</style><div id="view"></div>' +
    '<script type="importmap">' + JSON.stringify({imports: {
      three: new URL('vendor/build/three.module.js', values.url).href,
      'three/addons/': new URL('vendor/examples/jsm/', values.url).href,
    }}) + '</script>'}));
  await page.goto(new URL('__replay_resources__.html', values.url).href);
  const report = await page.evaluate(async base => {
    const THREE = await import('three');
    const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
    const {RoomView} = await import(new URL('replay/room-view.mjs', base));
    const {prefetch} = await import(new URL('replay/materialize.mjs', base));
    const {disposeModel} = await import(new URL('replay/resources.mjs', base));
    const check = (condition, message) => {if (!condition) throw new Error(message);};
    const frames = async (n = 2) => {for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);};
    const fixture = {asset: {version: '2.0'}, scene: 0, scenes: [{nodes: []}], nodes: [], meshes: [],
      materials: [], textures: [], images: [], buffers: [], bufferViews: [], accessors: []};
    const chunks = []; let byteOffset = 0;
    const accessor = (array, type, componentType, bounds = {}) => {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength), padded = new Uint8Array((bytes.length + 3) & ~3);
      padded.set(bytes); chunks.push(padded);
      const bufferView = fixture.bufferViews.push({buffer: 0, byteOffset, byteLength: bytes.length}) - 1;
      byteOffset += padded.length;
      return fixture.accessors.push({bufferView, componentType, count: array.length / ({SCALAR: 1, VEC2: 2, VEC3: 3}[type]), type, ...bounds}) - 1;
    };
    const shapes = [
      ['Floor0', [4, .1, 4], [0, -.05, 0]], ['Wall0', [4, 2, .1], [0, 1, -2]],
      ['Table0', [1.5, .1, 1], [0, 1, 0]], ['Chair0', [.4, .6, .4], [-1, .3, .8]],
      ['Chair1', [.4, .6, .4], [1, .3, .8]], ['Cabinet0', [.6, 1, .4], [1, .5, -1]],
    ];
    for (const [name, size, position] of shapes) {
      const canvas = Object.assign(document.createElement('canvas'), {width: 32, height: 32});
      const ctx = canvas.getContext('2d'); ctx.fillStyle = `hsl(${fixture.nodes.length * 40} 40% 60%)`; ctx.fillRect(0, 0, 32, 32);
      const image = fixture.images.push({uri: canvas.toDataURL()}) - 1;
      fixture.textures.push({source: image});
      const material = fixture.materials.push({pbrMetallicRoughness: {baseColorTexture: {index: image}, roughnessFactor: .8, metallicFactor: 0}}) - 1;
      const geometry = new THREE.BoxGeometry(...size); geometry.computeBoundingBox();
      const attributes = {POSITION: accessor(geometry.attributes.position.array, 'VEC3', 5126, {min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray()}),
        NORMAL: accessor(geometry.attributes.normal.array, 'VEC3', 5126), TEXCOORD_0: accessor(geometry.attributes.uv.array, 'VEC2', 5126)};
      const mesh = fixture.meshes.push({primitives: [{attributes, indices: accessor(geometry.index.array, 'SCALAR', 5123), material}]}) - 1;
      fixture.scenes[0].nodes.push(fixture.nodes.push({name, mesh, translation: position}) - 1);
      geometry.dispose();
    }
    const buffer = new Uint8Array(byteOffset); let offset = 0;
    for (const chunk of chunks) {buffer.set(chunk, offset); offset += chunk.length;}
    fixture.buffers.push({byteLength: buffer.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...buffer))});
    const url = URL.createObjectURL(new Blob([JSON.stringify(fixture)], {type: 'model/gltf+json'}));
    const view = new RoomView(document.querySelector('#view'), {background: '#e9ede5'});
    const snapshots = [], retired = [];
    const snapshot = iteration => ({iteration, ...view.renderer.info.memory, programs: view.renderer.info.programs.length,
      wallFades: view.wallFades.length, models: Object.keys(view.models).length, active: view.forming.active.size,
      cloneSources: view.forming.clones.size, pooledKits: view.forming.spare.length});
    try {
      for (let iteration = 0; iteration < 24; iteration++) {
        console.log('replay-check: draft', iteration);
        const previous = view.models[view.current]?.root;
        await view.show(`draft-${iteration}`, url, iteration % 2 === 0);
        if (view.incoming) {await frames(); view.swap(view.incoming);}
        const entry = view.models[view.current];
        await Promise.all([entry.warming, entry.prefetching]);
        if (previous) retired.push(previous);
        if (iteration % 4 === 0) {
          view.physical(true); await frames(); check(!!view.rig, 'physical lighting must activate');
          view.physical(false); check(!view.rig, 'physical lighting must restore replay materials');
        }
        view.speed = [1, 2, 8][iteration % 3];
        view.forming.start(entry.root.getObjectByName('Chair0'));
        view.forming.start(entry.root.getObjectByName('Chair1'));
        view.forming.update(.25);
        await frames(3);
        check(view.forming.active.size === 2, 'objects must still be taking shape during draft replacement');
        check(view.rate >= 1 && view.rate <= view.speed, 'playback speed must remain bounded');
        for (const root of retired) {
          check(!root.parent && root.children.length === 0, 'retired root must be detached and empty');
          check(!root.userData.warm && !root.userData.fadeMats, 'retired root must release warm and fade references');
          check(!view.wallFades.some(wall => wall.root === root), 'wall fade list must release retired roots');
        }
        snapshots.push(snapshot(iteration));
      }
      // A quiet backward seek must end effects and discard the current draft.
      console.log('replay-check: backward seek and asynchronous cancellation');
      view.apply({model: null, shell: false, points: 0, built: new Set()}, {quiet: true});
      check(!view.current && !view.forming.active.size && !view.wallFades.length, 'backward seek must clear draft effects');
      view.state = null;
      // A parsed GLB arriving after its draft was retired must never be attached.
      const originalLoad = GLTFLoader.prototype.loadAsync;
      let release, parsed, began;
      const beganPromise = new Promise(resolve => {began = resolve;});
      const gate = new Promise(resolve => {release = resolve;});
      GLTFLoader.prototype.loadAsync = async function (...args) {
        const result = await originalLoad.apply(this, args); parsed = result.scene; began(); await gate; return result;
      };
      const late = view.show('draft-late', url, true);
      await beganPromise;
      view.show(null, null, true);
      release(); await late;
      GLTFLoader.prototype.loadAsync = originalLoad;
      check(!view.models['draft-late'] && !parsed.parent && parsed.children.length === 0, 'late load must be discarded');
      // Retrying the same key is a different generation; the old completion cannot clear its intent.
      let retryRelease, retryBegan, oldRoot;
      const retryStarted = new Promise(resolve => {retryBegan = resolve;});
      const retryGate = new Promise(resolve => {retryRelease = resolve;});
      GLTFLoader.prototype.loadAsync = async function (...args) {
        const result = await originalLoad.apply(this, args); oldRoot = result.scene; retryBegan(); await retryGate; return result;
      };
      const older = view.show('draft-retry', url, true);
      await retryStarted; view.drop('draft-retry'); GLTFLoader.prototype.loadAsync = originalLoad;
      await view.show('draft-retry', url, true);
      const replacement = view.models['draft-retry'];
      retryRelease(); await older;
      check(view.wanted === 'draft-retry' && replacement.root !== oldRoot && oldRoot.children.length === 0,
        'stale same-key completion must not change the current generation');
      await view.drop('draft-retry');
      // Cancel prefetch while image decoding is still pending; its bitmap must close.
      let bitmapRelease, closed = 0;
      const originalBitmap = window.createImageBitmap;
      const bitmapGate = new Promise(resolve => {bitmapRelease = resolve;});
      window.createImageBitmap = () => bitmapGate;
      const tex = new THREE.Texture({width: 8, height: 8}), probe = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({map: tex}));
      const controller = new AbortController(), fetching = prefetch(probe, {signal: controller.signal});
      controller.abort(); bitmapRelease({close() {closed++;}}); await fetching;
      window.createImageBitmap = originalBitmap; disposeModel(probe);
      check(closed === 1, 'cancelled prefetch must close the late bitmap');
      // warm uploads only its first batch before yielding. Cancellation prevents later uploads.
      const originalInit = view.renderer.initTexture.bind(view.renderer); let uploads = 0;
      view.renderer.initTexture = texture => {uploads++; originalInit(texture);};
      const warming = await view.model('draft-warm', url), warmRoot = warming.root;
      const beforeCancel = uploads;
      view.drop('draft-warm');
      await Promise.all([warming.warming, warming.prefetching]);
      check(uploads === beforeCancel, 'retired warm job must not upload more textures');
      check(!warmRoot.userData.warm && !view.forming.clones.size, 'retired warm job must release proxies and clipped materials');
      await frames(3);
      const empty = snapshot('empty');
      await view.dispose();
      check(!view.forming.spare.length && !view.forming.clones.size && !view.forming.active.size, 'view disposal must release pooled materials');
      const closing = new RoomView(document.querySelector('#view'), {background: '#e9ede5'});
      const pending = await closing.model('draft-closing', url);
      await closing.dispose();
      await Promise.all([pending.warming, pending.prefetching]);
      check(!closing.retiring.size && !closing.forming.clones.size, 'view disposal must wait for in-flight compilation safely');
      return {drafts: 24, snapshots, empty, lateLoadDiscarded: true, latePrefetchClosed: true, cancelledWarmUploads: 0,
        backwardSeek: true, speeds: [1, 2, 8], physicalLighting: true, disposeDuringWarm: true, sameKeyGenerationSafe: true};
    } finally {await view.dispose(); URL.revokeObjectURL(url);}
  }, values.url);
  assert.deepEqual(errors, [], 'browser/shader errors');
  const steady = report.snapshots.slice(4);
  for (const field of ['geometries', 'textures', 'programs', 'cloneSources', 'wallFades', 'pooledKits']) {
    const counts = steady.map(row => row[field]);
    assert.ok(Math.max(...counts)-Math.min(...counts) <= 1, `${field} must plateau: ${counts}`);
  }
  assert.ok(steady.every(row => row.models === 1 && row.wallFades === 1 && row.active === 2));
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report));
} finally {clearTimeout(watchdog); await browser.close();}
