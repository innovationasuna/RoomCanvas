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
	fingerGuideMaxRatio: .8,
	confirmMs: 100,
	releaseConfirmMs: 40,
	menuHoldMs: 600,
	menuCloseHoldMs: 200,
	lossMs: 200,
	identityRadius: .18,
	minimumScore: .5,
	operatorScore: .8,
	minFacing: .6,
	filter: {
		minCutoff: 1.8,
		beta: .03,
		derivativeCutoff: 1
	},
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
var distance$2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function features(hand, aspect = 4 / 3) {
	const p = hand.landmarks;
	const n = p.map((v) => ({
		x: v.x * aspect,
		y: v.y,
		z: v.z * aspect
	}));
	const scale = (distance$2(n[0], n[5]) + distance$2(n[0], n[9]) + distance$2(n[0], n[17])) / 3;
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
	].every(([tip, pip]) => distance$2(n[tip], n[0]) > distance$2(n[pip], n[0]) * 1.15);
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
		pinchRatio: distance$2(n[4], n[8]) / Math.max(1e-6, scale),
		openPalm: extended && distance$2(n[4], n[8]) / Math.max(1e-6, scale) > .5,
		closedFist: [
			[8, 6],
			[12, 10],
			[16, 14],
			[20, 18]
		].every(([tip, pip]) => distance$2(n[tip], n[0]) < distance$2(n[pip], n[0]) * .95),
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
var distance$1 = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
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
	const palm = distance$1(p[0], p[9]);
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
		const reach = distance$1(p[tip], p[0]) / Math.max(1e-5, distance$1(p[pip], p[0]));
		if (pipAngle > .55 && dipAngle > .55 && reach > 1.1) return true;
		if (reach < .98 || (pipAngle < .45 || dipAngle < .35) && reach < 1.08) return false;
		return null;
	});
	if (states[0] !== true && states.slice(1).every((v) => v === true) && distance$1(p[4], p[8]) / palm < CONFIG.pinchEnter) return 3;
	if (states.some((v) => v === null)) return null;
	const pattern = states.map((v) => v ? "1" : "0").join("");
	const thumbFolded = distance$1(p[4], p[9]) / palm < .8;
	return pattern === "1000" ? 1 : pattern === "1100" ? 2 : pattern === "1110" ? 3 : pattern === "1111" && thumbFolded ? 4 : null;
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
//#region src/gestures/thumb-confirm.ts
var THUMB_CONFIRM = {
	holdMs: 500,
	neutralMs: 150,
	lossMs: 200
};
var length = (v) => Math.hypot(...v);
var subtract = (a, b) => a.map((v, i) => v - b[i]);
var distance = (a, b) => length(subtract(a, b));
var cosine = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0) / Math.max(1e-10, length(a) * length(b));
function isRightThumbsUp(hand, aspect = 4 / 3) {
	if (hand.side !== "Right" || !validHand(hand) || !Number.isFinite(aspect) || aspect <= 0) return false;
	const p = hand.landmarks.map((v) => [
		v.x * aspect,
		v.y,
		v.z * aspect
	]);
	const palm = (distance(p[0], p[5]) + distance(p[0], p[9]) + distance(p[0], p[17])) / 3;
	if (palm < 1e-5) return false;
	const folded = [
		5,
		9,
		13,
		17
	].every((mcp) => {
		const proximal = subtract(p[mcp + 1], p[mcp]);
		const middle = subtract(p[mcp + 2], p[mcp + 1]);
		const distal = subtract(p[mcp + 3], p[mcp + 2]);
		if ([
			proximal,
			middle,
			distal
		].some((v) => length(v) < palm * .04)) return false;
		const reach = distance(p[mcp + 3], p[0]) / Math.max(1e-5, distance(p[mcp + 1], p[0]));
		return reach < .98 || (cosine(proximal, middle) < .45 || cosine(middle, distal) < .35) && reach < 1.08;
	});
	const proximal = subtract(p[3], p[2]), distal = subtract(p[4], p[3]), thumb = subtract(p[4], p[2]);
	return folded && length(proximal) > palm * .12 && length(distal) > palm * .12 && cosine(proximal, distal) > .65 && -thumb[1] > palm * .45 && -thumb[1] / length(thumb) > .72 && -distal[1] > palm * .08 && p[4][1] < Math.min(...[
		5,
		9,
		13,
		17
	].map((i) => p[i][1])) - palm * .12 && distance(p[4], p[8]) > palm * .5;
}
var ThumbConfirmSelector = class {
	feedback = {
		phase: "missing",
		progress: 0
	};
	get state() {
		return { ...this.feedback };
	}
	since = null;
	neutralSince = null;
	lastSeen = null;
	wrist = null;
	previewId = null;
	armed = true;
	sent = false;
	reset(requireNeutral = true) {
		this.since = this.neutralSince = this.lastSeen = null;
		this.wrist = null;
		this.previewId = null;
		this.armed = !requireNeutral;
		this.sent = false;
		this.feedback = {
			phase: "missing",
			progress: 0
		};
	}
	process(frame, aspect, previewId, allowed = true) {
		const candidates = frame.hands.filter((h) => h.side === "Right");
		const right = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : void 0;
		if (!right || !Number.isFinite(frame.timestamp)) {
			this.reset();
			this.feedback.phase = candidates.length > 1 ? "ambiguous" : candidates.length ? "uncertain" : "missing";
			return null;
		}
		const wrist = right.landmarks[0], time = frame.timestamp;
		if (this.lastSeen !== null && (time <= this.lastSeen || time - this.lastSeen >= THUMB_CONFIRM.lossMs) || this.wrist && Math.hypot(wrist.x - this.wrist.x, wrist.y - this.wrist.y) > CONFIG.identityRadius) this.reset();
		this.wrist = wrist;
		this.lastSeen = time;
		const thumb = isRightThumbsUp(right, aspect);
		if (this.previewId !== previewId) {
			this.since = null;
			if (this.previewId && previewId && thumb) this.armed = false;
			this.previewId = previewId;
		}
		if (!thumb) {
			this.since = null;
			this.neutralSince ??= time;
			if (time - this.neutralSince >= THUMB_CONFIRM.neutralMs) {
				this.armed = true;
				this.sent = false;
			}
			this.feedback = {
				phase: previewId ? "pose" : "waiting",
				progress: 0
			};
			return null;
		}
		this.neutralSince = null;
		if (!previewId || !allowed) {
			this.since = null;
			if (!previewId) this.armed = false;
			this.feedback = {
				phase: this.sent ? "sent" : previewId ? "blocked" : "waiting",
				progress: this.sent ? 1 : 0
			};
			return null;
		}
		if (!this.armed) {
			this.feedback = {
				phase: this.sent ? "sent" : "neutral",
				progress: this.sent ? 1 : 0
			};
			return null;
		}
		this.since ??= time;
		const progress = Math.min(1, (time - this.since) / THUMB_CONFIRM.holdMs);
		this.feedback = {
			phase: "confirming",
			progress
		};
		if (progress < 1) return null;
		this.armed = false;
		this.sent = true;
		this.since = null;
		this.feedback = {
			phase: "sent",
			progress: 1
		};
		return previewId;
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
	thumb = new ThumbConfirmSelector();
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
				const leftHeld = frame.hands.some((h) => h.side === "Left" && validHand(h) && features(h, aspect).pinchRatio < CONFIG.pinchExit);
				const left = frame.hands.filter((h) => h.side === "Left");
				const selectingThree = this.callbacks.canSwitch() && !rightHeld && !gesture.operator?.pinching && !gesture.operator?.releasing && left.length === 1 && leftHeld && classifyLeftNumber(left[0], aspect) === 3;
				if (selectingThree) {
					gesture.helper = void 0;
					gesture.helperInterrupted = true;
				}
				const target = this.callbacks.confirmationTarget();
				const safeRight = !!gesture.operator && !gesture.interrupted && !gesture.ambiguous;
				if (!safeRight) this.thumb.reset();
				const placementConfirmation = this.thumb.process(frame, aspect, target.previewId, target.allowed && safeRight && !rightHeld && !gesture.operator?.pinching && !gesture.operator?.releasing);
				const rightConfirmation = this.thumb.state;
				const modeSelection = this.numbers.process(frame, aspect, this.callbacks.canSwitch() && !rightHeld && (!leftHeld || selectingThree) && rightConfirmation.phase !== "confirming" && !placementConfirmation);
				this.callbacks.frame({
					...gesture,
					observation,
					modeSelection,
					leftDetection: this.numbers.state,
					rightHeld,
					placementConfirmation,
					rightConfirmation
				}, performance.timeOrigin + frame.timestamp, frame);
			};
			await this.tracker.start();
			if (generation !== this.generation) return false;
			if (!await this.camera.start(device) || generation !== this.generation) return false;
			this.gestures.reset();
			this.observation.reset();
			this.numbers.reset(false);
			this.thumb.reset(false);
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
		this.thumb.reset();
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
//#region src/shared/hand-guide.ts
function showFingerGuide(hand) {
	const ratio = hand?.pinchRatio;
	return !!hand?.fingertips && typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio < CONFIG.fingerGuideMaxRatio;
}
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
	const signal = (h) => {
		const p = handPointer(h);
		if (!h || !p) return void 0;
		const tip = (p) => ({
			u: Math.max(0, Math.min(1, p.x)),
			v: Math.max(0, Math.min(1, p.y))
		});
		return {
			...p,
			pinching: h.pinching,
			started: h.started,
			ended: h.ended,
			releasing: h.releasing ?? false,
			palmScale: h.palmScale,
			frontFacing: h.frontFacing,
			...typeof h.pinchRatio === "number" && Number.isFinite(h.pinchRatio) && h.pinchRatio >= 0 ? { pinchRatio: h.pinchRatio } : {},
			...showFingerGuide(h) && h.fingertips ? { fingertips: {
				thumb: tip(h.fingertips.thumb),
				index: tip(h.fingertips.index)
			} } : {}
		};
	};
	return {
		operator: signal(frame.operator),
		helper: signal(frame.helper),
		interrupted: frame.interrupted,
		helperInterrupted: frame.helperInterrupted ?? false,
		ambiguous: frame.ambiguous
	};
}
function observationPayload(frame) {
	const h = frame.operator, p = handPointer(h);
	return {
		operator: h && p ? {
			...p,
			pinching: h.pinching,
			started: h.started,
			ended: h.ended,
			releasing: h.releasing ?? false,
			observation: h.action
		} : void 0,
		helper: handPointer(frame.helper),
		interrupted: frame.interrupted,
		ambiguous: false
	};
}
//#endregion
export { GestureRuntime, gesturePayload, observationPayload, setVisionBase };
