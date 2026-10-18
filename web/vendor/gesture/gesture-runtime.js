//#region src/camera/camera.ts
var CameraSource = class {
	video;
	stream;
	generation = 0;
	onDisconnect;
	constructor(video) {
		this.video = video;
	}
	async devices() {
		return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
	}
	async start(deviceId) {
		this.stop();
		const generation = this.generation;
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				width: { ideal: 640 },
				height: { ideal: 480 },
				frameRate: { ideal: 30 },
				...deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }
			}
		});
		if (generation !== this.generation) {
			stream.getTracks().forEach((t) => t.stop());
			return false;
		}
		this.stream = stream;
		for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => this.onDisconnect?.(), { once: true });
		this.video.srcObject = stream;
		try {
			await this.video.play();
		} catch (error) {
			this.stop();
			throw error;
		}
		return generation === this.generation;
	}
	stop() {
		this.generation++;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = void 0;
		this.video.srcObject = null;
	}
};
//#endregion
//#region src/embed/tracker.ts
var visionBase = new URL("/vision/", location.href).href;
function setVisionBase(url) {
	visionBase = new URL(url, location.href).href.replace(/\/?$/, "/");
}
var Tracker = class {
	worker;
	busy = false;
	generation = 0;
	ready = false;
	cancelInit;
	onFrame;
	onError;
	async start() {
		this.stop();
		const generation = this.generation;
		const worker = new Worker(new URL(
			/* @vite-ignore */
			new URL("gesture-worker.js", import.meta.url).href,
			"" + import.meta.url
		), { type: "module" });
		this.worker = worker;
		await new Promise((resolve, reject) => {
			const timeout = window.setTimeout(() => reject(/* @__PURE__ */ new Error("识别资源加载超时，请检查 vision 资源")), 3e4);
			this.cancelInit = (error) => {
				clearTimeout(timeout);
				reject(error);
			};
			worker.onmessage = (event) => {
				if (generation !== this.generation) return;
				if (event.data.type === "ready") {
					this.ready = true;
					clearTimeout(timeout);
					this.cancelInit = void 0;
					resolve();
				} else if (event.data.type === "result") {
					this.busy = false;
					this.onFrame?.(event.data.frame);
				} else {
					this.busy = false;
					clearTimeout(timeout);
					reject(new Error(event.data.error));
					this.onError?.(event.data.error);
				}
			};
			worker.onerror = (event) => {
				this.busy = false;
				clearTimeout(timeout);
				reject(new Error(event.message));
				this.onError?.(event.message);
			};
			worker.postMessage({
				type: "init",
				wasm: new URL("wasm", visionBase).href,
				model: new URL("hand_landmarker.task", visionBase).href
			});
		});
	}
	async detect(video, timestamp) {
		if (!this.ready || this.busy || video.readyState < 2) return;
		this.busy = true;
		const generation = this.generation;
		try {
			const bitmap = await createImageBitmap(video);
			if (generation !== this.generation || !this.worker) {
				bitmap.close();
				return;
			}
			this.worker.postMessage({
				type: "frame",
				bitmap,
				timestamp
			}, [bitmap]);
		} catch (error) {
			this.busy = false;
			this.onError?.(String(error));
		}
	}
	stop() {
		this.generation++;
		this.cancelInit?.(/* @__PURE__ */ new Error("识别初始化已取消"));
		this.cancelInit = void 0;
		this.worker?.terminate();
		this.worker = void 0;
		this.ready = false;
		this.busy = false;
	}
};
//#endregion
//#region src/shared/config.ts
var CONFIG = {
	pinchEnter: .25,
	pinchExit: .3,
	confirmMs: 100,
	releaseConfirmMs: 40,
	fingerGuideMaxRatio: .8,
	menuHoldMs: 600,
	menuCloseHoldMs: 200,
	lossMs: 200,
	identityRadius: .18,
	minimumScore: .5,
	operatorScore: .8,
	xyGain: 5,
	depthGain: 2,
	maxDepthRatio: 2.5,
	minFacing: .6,
	rotateGain: Math.PI,
	rotationSnap: Math.PI / 12,
	heightGain: 3,
	room: {
		width: 6,
		depth: 5,
		height: 3
	},
	filter: {
		minCutoff: 1.8,
		beta: .03,
		derivativeCutoff: 1
	},
	minScale: .5,
	maxScale: 2,
	inferenceInterval: 1e3 / 30
};
//#endregion
//#region src/shared/filter.ts
var OneEuroFilter = class {
	minCutoff;
	beta;
	derivativeCutoff;
	value;
	derivative = 0;
	raw;
	time;
	constructor(minCutoff = 1.8, beta = .03, derivativeCutoff = 1) {
		this.minCutoff = minCutoff;
		this.beta = beta;
		this.derivativeCutoff = derivativeCutoff;
	}
	update(value, timeMs) {
		if (this.value === void 0 || this.time === void 0) {
			this.value = value;
			this.raw = value;
			this.time = timeMs;
			return value;
		}
		const dt = Math.max(.001, (timeMs - this.time) / 1e3);
		const alpha = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
		this.derivative += alpha(this.derivativeCutoff) * ((value - this.raw) / dt - this.derivative);
		this.value += alpha(this.minCutoff + this.beta * Math.abs(this.derivative)) * (value - this.value);
		this.time = timeMs;
		this.raw = value;
		return this.value;
	}
	reset() {
		this.value = void 0;
		this.raw = void 0;
		this.time = void 0;
		this.derivative = 0;
	}
};
//#endregion
//#region src/gestures/features.ts
var distance$1 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function features(hand, aspect = 4 / 3) {
	const p = hand.landmarks;
	const n = p.map((v) => ({
		x: v.x * aspect,
		y: v.y,
		z: v.z * aspect
	}));
	const scale = (distance$1(n[0], n[5]) + distance$1(n[0], n[9]) + distance$1(n[0], n[17])) / 3;
	const projected = (i) => Math.hypot(n[i].x - n[0].x, n[i].y - n[0].y);
	const palmScale = (projected(5) + projected(9) + projected(17)) / 3;
	const w = hand.world.length === 21 ? hand.world : n;
	const a = {
		x: w[5].x - w[0].x,
		y: w[5].y - w[0].y,
		z: w[5].z - w[0].z
	};
	const b = {
		x: w[17].x - w[0].x,
		y: w[17].y - w[0].y,
		z: w[17].z - w[0].z
	};
	const cross = {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x
	};
	const facing = Math.abs(cross.z) / Math.max(1e-6, Math.hypot(cross.x, cross.y, cross.z));
	const extended = [
		[8, 6],
		[12, 10],
		[16, 14],
		[20, 18]
	].every(([tip, pip]) => distance$1(n[tip], n[0]) > distance$1(n[pip], n[0]) * 1.15);
	return {
		pointer: {
			x: 1 - (p[4].x + p[8].x) / 2,
			y: (p[4].y + p[8].y) / 2
		},
		fingertips: {
			thumb: {
				x: 1 - p[4].x,
				y: p[4].y
			},
			index: {
				x: 1 - p[8].x,
				y: p[8].y
			}
		},
		wrist: {
			x: p[0].x,
			y: p[0].y
		},
		palmScale,
		pinchRatio: distance$1(n[4], n[8]) / Math.max(1e-6, scale),
		openPalm: extended && distance$1(n[4], n[8]) / Math.max(1e-6, scale) > .5,
		closedFist: [
			[8, 6],
			[12, 10],
			[16, 14],
			[20, 18]
		].every(([tip, pip]) => distance$1(n[tip], n[0]) < distance$1(n[pip], n[0]) * .95),
		frontFacing: facing >= CONFIG.minFacing
	};
}
//#endregion
//#region src/gestures/engine.ts
var PinchLatch = class {
	active = false;
	pending;
	desired = false;
	blocked = false;
	update(ratio, time) {
		let started = false, ended = false;
		if (this.blocked) {
			if (ratio >= CONFIG.pinchExit) {
				this.blocked = false;
				this.active = false;
				this.pending = void 0;
			}
			return {
				pinching: false,
				started,
				ended,
				releasing: false
			};
		}
		const desired = this.active ? ratio < CONFIG.pinchExit : ratio < CONFIG.pinchEnter;
		const releasing = this.active && !desired;
		if (desired === this.active) this.pending = void 0;
		else if (this.pending === void 0 || desired !== this.desired) {
			this.pending = time;
			this.desired = desired;
		} else if (time - this.pending >= (desired ? CONFIG.confirmMs : CONFIG.releaseConfirmMs)) {
			this.active = desired;
			this.pending = void 0;
			started = desired;
			ended = !desired;
		}
		return {
			pinching: this.active,
			started,
			ended,
			releasing
		};
	}
	interrupt() {
		this.active = false;
		this.pending = void 0;
		this.blocked = true;
	}
};
var SignalTracker = class {
	latch = new PinchLatch();
	filters = [
		new OneEuroFilter(),
		new OneEuroFilter(),
		new OneEuroFilter(1, .01)
	];
	wrist;
	stable;
	update(hand, time, aspect) {
		const f = features(hand, aspect);
		this.wrist = f.wrist;
		const pinch = this.latch.update(f.pinchRatio, time);
		const motion = pinch.releasing && this.stable ? this.stable : {
			pointer: {
				x: this.filters[0].update(f.pointer.x, time),
				y: this.filters[1].update(f.pointer.y, time)
			},
			palmScale: this.filters[2].update(f.palmScale, time)
		};
		this.stable = motion;
		const pointer = motion.pointer;
		const offset = {
			x: pointer.x - f.pointer.x,
			y: pointer.y - f.pointer.y
		};
		const tip = (p) => ({
			x: p.x + offset.x,
			y: p.y + offset.y
		});
		return {
			...f,
			pointer,
			fingertips: {
				thumb: tip(f.fingertips.thumb),
				index: tip(f.fingertips.index)
			},
			palmScale: motion.palmScale,
			...pinch
		};
	}
	reset() {
		this.wrist = void 0;
		this.stable = void 0;
		this.filters.forEach((f) => f.reset());
		this.latch.interrupt();
	}
};
function selectHand(valid, side, tracker) {
	const candidates = valid.filter((h) => h.side === side);
	if (candidates.length > 1) return { ambiguous: true };
	if (tracker.latch.active && tracker.wrist) {
		const wrist = tracker.wrist;
		const ranked = valid.map((h) => ({
			h,
			d: Math.hypot(h.landmarks[0].x - wrist.x, h.landmarks[0].y - wrist.y)
		})).sort((a, b) => a.d - b.d);
		const ambiguous = ranked.length > 1 && Math.abs(ranked[0].d - ranked[1].d) < .045;
		const nearest = ranked[0];
		return {
			ambiguous,
			hand: !ambiguous && nearest?.d < CONFIG.identityRadius && nearest.h.side === side && nearest.h.score >= CONFIG.operatorScore ? nearest.h : void 0
		};
	}
	return {
		ambiguous: false,
		hand: candidates.find((h) => h.score >= CONFIG.operatorScore)
	};
}
var GestureEngine = class {
	operator = new SignalTracker();
	helper = new SignalTracker();
	missingSince;
	helperMissingSince;
	interrupted = false;
	palmSince;
	fistSince;
	closeArmed = true;
	menuArmed = true;
	reset() {
		this.operator.reset();
		this.helper.reset();
		this.palmSince = void 0;
		this.fistSince = void 0;
		this.closeArmed = true;
		this.missingSince = void 0;
		this.helperMissingSince = void 0;
		this.interrupted = false;
	}
	process(frame, aspect = 4 / 3) {
		const valid = frame.hands.filter((h) => h.score >= CONFIG.minimumScore && h.landmarks.length === 21 && h.landmarks.every((p) => Number.isFinite(p.x + p.y + p.z)));
		const { hand: op, ambiguous } = selectHand(valid, "Right", this.operator);
		const { hand: help } = selectHand(valid, "Left", this.helper);
		let interrupted = false, helperInterrupted = false;
		if (!op) {
			this.missingSince ??= frame.timestamp;
			if (frame.timestamp - this.missingSince >= CONFIG.lossMs && !this.interrupted) {
				this.operator.reset();
				this.interrupted = true;
				interrupted = true;
			}
		} else {
			if (this.missingSince !== void 0 && frame.timestamp - this.missingSince >= CONFIG.lossMs && !this.interrupted) {
				this.operator.reset();
				interrupted = true;
			}
			this.missingSince = void 0;
			this.interrupted = false;
		}
		if (!help) this.helperMissingSince ??= frame.timestamp;
		if (this.helperMissingSince !== void 0 && frame.timestamp - this.helperMissingSince >= CONFIG.lossMs) {
			if (this.helper.latch.active) helperInterrupted = true;
			this.helper.reset();
		}
		if (help) this.helperMissingSince = void 0;
		const operator = op ? this.operator.update(op, frame.timestamp, aspect) : void 0;
		const helper = help ? this.helper.update(help, frame.timestamp, aspect) : void 0;
		let menuRequested = false;
		if (helper?.openPalm && !helper.pinching && !operator?.pinching) {
			this.palmSince ??= frame.timestamp;
			if (this.menuArmed && frame.timestamp - this.palmSince >= CONFIG.menuHoldMs) {
				menuRequested = true;
				this.menuArmed = false;
			}
		} else {
			this.palmSince = void 0;
			this.menuArmed = true;
		}
		let menuCloseRequested = false;
		if (helper?.closedFist) {
			this.fistSince ??= frame.timestamp;
			if (this.closeArmed && frame.timestamp - this.fistSince >= CONFIG.menuCloseHoldMs) {
				menuCloseRequested = true;
				this.closeArmed = false;
			}
		} else {
			this.fistSince = void 0;
			this.closeArmed = true;
		}
		return {
			timestamp: frame.timestamp,
			operator,
			helper,
			menuRequested,
			menuCloseRequested,
			interrupted,
			helperInterrupted,
			ambiguous
		};
	}
};
//#endregion
//#region src/gestures/number-mode.ts
var NUMBER_CONFIG = {
	holdMs: 400,
	neutralMs: 150,
	lossMs: 200
};
var distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
function validHand(hand) {
	return hand.score >= CONFIG.operatorScore && hand.landmarks.length === 21 && hand.landmarks.every((p) => Number.isFinite(p.x + p.y + p.z));
}
function classifyLeftNumber(hand, aspect = 4 / 3) {
	if (hand.side !== "Left" || !validHand(hand)) return null;
	const p = hand.landmarks.map((v) => [
		v.x * aspect,
		v.y,
		v.z * aspect
	]);
	const palm = distance(p[0], p[9]);
	if (palm < 1e-5) return null;
	const states = [
		5,
		9,
		13,
		17
	].map((mcp) => {
		const pip = mcp + 1, dip = mcp + 2, tip = mcp + 3;
		const cosine = (a, b) => {
			const lengths = Math.hypot(...a) * Math.hypot(...b);
			return lengths < palm * palm * .001 ? null : a.reduce((sum, n, i) => sum + n * b[i], 0) / lengths;
		};
		const proximal = p[pip].map((n, i) => n - p[mcp][i]);
		const middle = p[dip].map((n, i) => n - p[pip][i]);
		const distal = p[tip].map((n, i) => n - p[dip][i]);
		const pipAngle = cosine(proximal, middle), dipAngle = cosine(middle, distal);
		if (pipAngle === null || dipAngle === null) return null;
		const reach = distance(p[tip], p[0]) / Math.max(1e-5, distance(p[pip], p[0]));
		if (pipAngle > .55 && dipAngle > .55 && reach > 1.1) return true;
		if (reach < .98 || (pipAngle < .45 || dipAngle < .35) && reach < 1.08) return false;
		return null;
	});
	if (states.some((v) => v === null)) return null;
	const pattern = states.map((v) => v ? "1" : "0").join("");
	return pattern === "1000" ? 1 : pattern === "1100" ? 2 : pattern === "1110" ? 3 : null;
}
var NumberModeSelector = class {
	feedback = {
		detected: false,
		digit: null,
		progress: 0,
		phase: "missing"
	};
	get state() {
		return { ...this.feedback };
	}
	pending = null;
	lastDigit = null;
	since = 0;
	neutralSince = null;
	armed = true;
	lastSeen = null;
	wrist = null;
	reset(requireNeutral = true) {
		this.pending = null;
		this.lastDigit = null;
		this.neutralSince = null;
		this.armed = !requireNeutral;
		this.lastSeen = null;
		this.wrist = null;
		this.feedback = {
			detected: false,
			digit: null,
			progress: 0,
			phase: "missing"
		};
	}
	process(frame, aspect, allowed) {
		const candidates = frame.hands.filter((h) => h.side === "Left");
		const left = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : void 0;
		if (!allowed) {
			this.pending = null;
			this.neutralSince = null;
			this.armed = false;
		}
		if (!left) {
			this.feedback = {
				detected: false,
				digit: null,
				progress: 0,
				phase: candidates.length > 1 ? "ambiguous" : candidates.length ? "uncertain" : "missing"
			};
			this.pending = null;
			this.neutralSince = null;
			if (this.lastSeen !== null && frame.timestamp - this.lastSeen >= NUMBER_CONFIG.lossMs) this.armed = false;
			return null;
		}
		if (this.lastSeen !== null && frame.timestamp - this.lastSeen >= NUMBER_CONFIG.lossMs) this.armed = false;
		const wrist = left.landmarks[0];
		if (this.wrist && Math.hypot(wrist.x - this.wrist.x, wrist.y - this.wrist.y) > CONFIG.identityRadius) {
			this.armed = false;
			this.pending = null;
		}
		this.wrist = wrist;
		this.lastSeen = frame.timestamp;
		const digit = classifyLeftNumber(left, aspect);
		if (!allowed) {
			this.feedback = {
				detected: true,
				digit,
				progress: 0,
				phase: "blocked"
			};
			return null;
		}
		if (digit === null) {
			this.feedback = {
				detected: true,
				digit: null,
				progress: 0,
				phase: "pose"
			};
			this.pending = null;
			this.neutralSince ??= frame.timestamp;
			if (frame.timestamp - this.neutralSince >= NUMBER_CONFIG.neutralMs) {
				this.armed = true;
				this.lastDigit = null;
			}
			return null;
		}
		this.neutralSince = null;
		if (!this.armed) {
			this.pending = null;
			this.feedback = {
				detected: true,
				digit,
				progress: 0,
				phase: "neutral"
			};
			return null;
		}
		if (digit === this.lastDigit) {
			this.pending = null;
			this.feedback = {
				detected: true,
				digit,
				progress: 1,
				phase: "selected"
			};
			return null;
		}
		if (digit !== this.pending) {
			this.pending = digit;
			this.since = frame.timestamp;
			this.feedback = {
				detected: true,
				digit,
				progress: 0,
				phase: "confirming"
			};
			return null;
		}
		this.feedback = {
			detected: true,
			digit,
			progress: Math.min(1, (frame.timestamp - this.since) / NUMBER_CONFIG.holdMs),
			phase: "confirming"
		};
		if (frame.timestamp - this.since < NUMBER_CONFIG.holdMs) return null;
		this.lastDigit = digit;
		this.pending = null;
		this.feedback = {
			detected: true,
			digit,
			progress: 1,
			phase: "selected"
		};
		return digit;
	}
};
//#endregion
//#region src/gestures/observe-pinch.ts
var ObservationRecognizer = class {
	latch = new PinchLatch();
	action = null;
	needsOpen = true;
	filters = [new OneEuroFilter(), new OneEuroFilter()];
	stable;
	wrist;
	missingSince = null;
	lastTime = null;
	reset() {
		this.latch.interrupt();
		this.action = null;
		this.needsOpen = true;
		this.filters.forEach((f) => f.reset());
		this.stable = void 0;
		this.wrist = void 0;
		this.missingSince = null;
		this.lastTime = null;
	}
	process(frame, aspect = 4 / 3) {
		const valid = frame.hands.filter(validHand);
		const candidates = frame.hands.filter((h) => h.side === "Right");
		let right = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : void 0;
		if (right && this.latch.active && this.wrist) {
			const ranked = valid.map((h) => ({
				hand: h,
				distance: Math.hypot(h.landmarks[0].x - this.wrist.x, h.landmarks[0].y - this.wrist.y)
			})).sort((a, b) => a.distance - b.distance);
			if (!ranked[0] || ranked[0].hand !== right || ranked[0].distance >= CONFIG.identityRadius || ranked[1] && Math.abs(ranked[1].distance - ranked[0].distance) < .045) right = void 0;
		}
		const gap = this.lastTime !== null && frame.timestamp - this.lastTime >= CONFIG.lossMs;
		this.lastTime = frame.timestamp;
		if (!right) {
			this.missingSince ??= frame.timestamp;
			if (gap || frame.timestamp - this.missingSince >= CONFIG.lossMs) {
				this.reset();
				return { interrupted: true };
			}
			return { interrupted: false };
		}
		if (gap || this.missingSince !== null && frame.timestamp - this.missingSince >= CONFIG.lossMs) {
			this.reset();
			return { interrupted: true };
		}
		this.missingSince = null;
		this.wrist = right.landmarks[0];
		const f = features(right, aspect);
		const points = right.landmarks.map((p) => ({
			x: p.x * aspect,
			y: p.y,
			z: p.z * aspect
		}));
		const dist = (a, b) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y, points[a].z - points[b].z);
		const scale = (dist(0, 5) + dist(0, 9) + dist(0, 17)) / 3;
		const triple = Math.max(dist(4, 8), dist(4, 12), dist(8, 12)) / Math.max(1e-6, scale);
		if (this.needsOpen) {
			if (f.pinchRatio >= CONFIG.pinchExit) {
				this.needsOpen = false;
				this.latch.update(f.pinchRatio, frame.timestamp);
			}
		} else if (!this.action && f.pinchRatio < CONFIG.pinchEnter) this.action = triple < CONFIG.pinchEnter ? "pan" : "orbit";
		const action = this.action ?? "orbit";
		const ratio = this.needsOpen ? Math.max(f.pinchRatio, CONFIG.pinchExit) : action === "pan" ? triple : f.pinchRatio;
		const pinch = this.latch.update(ratio, frame.timestamp);
		const pointer = pinch.releasing && this.stable ? this.stable : {
			x: this.filters[0].update(f.pointer.x, frame.timestamp),
			y: this.filters[1].update(f.pointer.y, frame.timestamp)
		};
		this.stable = pointer;
		if (pinch.ended) {
			this.action = null;
			this.needsOpen = true;
			this.latch.interrupt();
		}
		if (!pinch.pinching && !pinch.releasing && f.pinchRatio >= CONFIG.pinchExit) this.action = null;
		return {
			interrupted: false,
			operator: {
				...f,
				...pinch,
				pointer,
				action
			}
		};
	}
};
//#endregion
//#region src/integration/runtime.ts
var GestureRuntime = class {
	video;
	callbacks;
	camera;
	tracker = new Tracker();
	gestures = new GestureEngine();
	numbers = new NumberModeSelector();
	observation = new ObservationRecognizer();
	generation = 0;
	running = false;
	animation = 0;
	lastInference = 0;
	lastVideoTime = -1;
	lastResult = 0;
	stale = false;
	constructor(video, callbacks) {
		this.video = video;
		this.callbacks = callbacks;
		this.camera = new CameraSource(video);
		this.camera.onDisconnect = () => {
			this.stop();
			this.callbacks.error("摄像头已断开，请重新开启。");
		};
	}
	async start(device) {
		this.stop();
		const generation = this.generation;
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error("请使用 localhost 页面并允许摄像头权限。");
			this.tracker.onError = (error) => {
				this.stop();
				this.callbacks.error(error);
			};
			this.tracker.onFrame = (frame) => {
				if (!this.running || generation !== this.generation) return;
				const now = performance.now();
				if (now - frame.timestamp > 250 || document.hidden) {
					this.interrupt();
					return;
				}
				this.lastResult = now;
				this.stale = false;
				const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);
				const gesture = this.gestures.process(frame, aspect);
				const observation = this.observation.process(frame, aspect);
				const rightHeld = frame.hands.some((h) => h.side === "Right" && validHand(h) && features(h, aspect).pinchRatio < CONFIG.pinchExit);
				const modeSelection = this.numbers.process(frame, aspect, this.callbacks.canSwitch() && !rightHeld);
				this.callbacks.frame({
					...gesture,
					observation,
					modeSelection,
					leftDetection: this.numbers.state,
					rightHeld
				}, performance.timeOrigin + frame.timestamp, frame.inferenceMs);
			};
			await this.tracker.start();
			if (generation !== this.generation) return false;
			if (!await this.camera.start(device) || generation !== this.generation) return false;
			this.gestures.reset();
			this.observation.reset();
			this.numbers.reset(false);
			this.running = true;
			this.stale = false;
			this.lastResult = performance.now();
			this.lastInference = 0;
			this.lastVideoTime = -1;
			this.animation = requestAnimationFrame(this.loop);
			return true;
		} catch (error) {
			if (generation !== this.generation) return false;
			this.stop();
			this.callbacks.error(error instanceof Error ? error.message : String(error));
			return false;
		}
	}
	interrupt(cancelPending = false, preserveNumbers = false) {
		this.gestures.reset();
		this.observation.reset();
		if (!preserveNumbers) this.numbers.reset();
		this.callbacks.interrupted(cancelPending);
	}
	loop = (now) => {
		if (!this.running) return;
		if (!document.hidden && now - this.lastInference >= CONFIG.inferenceInterval && this.video.currentTime !== this.lastVideoTime) {
			this.lastInference = now;
			this.lastVideoTime = this.video.currentTime;
			this.tracker.detect(this.video, now);
		}
		if (now - this.lastResult > CONFIG.lossMs && !this.stale) {
			this.stale = true;
			this.interrupt();
		}
		this.animation = requestAnimationFrame(this.loop);
	};
	stop() {
		this.generation++;
		this.running = false;
		cancelAnimationFrame(this.animation);
		this.tracker.stop();
		this.camera.stop();
		this.interrupt(true);
	}
};
//#endregion
//#region src/integration/protocol.ts
function handPointer(signal) {
	const p = signal?.pointer;
	return p && Number.isFinite(p.x + p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 ? {
		u: p.x,
		v: p.y
	} : void 0;
}
function gesturePayload(frame) {
	const h = frame.operator;
	const operator = h && Number.isFinite(h.pointer.x + h.pointer.y) && h.pointer.x >= 0 && h.pointer.x <= 1 && h.pointer.y >= 0 && h.pointer.y <= 1 ? {
		u: h.pointer.x,
		v: h.pointer.y,
		pinching: h.pinching,
		started: h.started,
		ended: h.ended,
		releasing: h.releasing ?? false
	} : void 0;
	const helper = handPointer(frame.helper);
	return {
		operator,
		...helper ? { helper } : {},
		interrupted: frame.interrupted,
		ambiguous: frame.ambiguous
	};
}
function observationPayload(frame) {
	const payload = gesturePayload({
		...frame,
		timestamp: 0,
		menuRequested: false,
		ambiguous: false
	});
	return {
		...payload,
		operator: payload.operator ? {
			...payload.operator,
			observation: frame.operator.action
		} : void 0
	};
}
//#endregion
export { GestureRuntime, gesturePayload, observationPayload, setVisionBase };
