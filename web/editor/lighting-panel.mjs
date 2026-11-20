import {colorGrading, DEFAULT_GRADING} from './color-grading.mjs';
import {timePreset} from './time-lighting.mjs';
import {indoorLighting} from './indoor-lighting.mjs';

export function mountLightingPanel({root, timeRoot, initialTime, initialIndoor, onTime, onIndoor, onGrade}) {
  const select = timeRoot.querySelector('#lighting-time');
  const timeChoices = [...timeRoot.querySelectorAll('[name="lighting-time-choice"]')];
  const angle = timeRoot.querySelector('#lamp-angle'), power = timeRoot.querySelector('#lamp-power');
  const ranges = [...root.querySelectorAll('[data-grade]')];
  for (const menu of [root, timeRoot]) {
    root.ownerDocument.addEventListener('click', event => {if (!menu.contains(event.target)) menu.open = false;});
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus();}
    });
  }
  let values = colorGrading(), time = timePreset(initialTime);
  let indoor = indoorLighting(initialIndoor), canLight = false;
  // With ceiling luminaires the switch is the room's lights; without, the invented central lamp.
  let fixtures = 0;
  const note = timeRoot.querySelector('.rc-lighting-note'), centralNote = note?.textContent;
  const lampName = () => fixtures ? `室内灯 · ${fixtures} 盏` : '中央顶灯';
  const format = (key, value) => key === 'exposure' ? `${value > 0 ? '+' : ''}${value.toFixed(2)} EV`
    : key === 'whiteBalance' ? value === 0 ? '中性' : `${value > 0 ? '偏暖' : '偏冷'} ${Math.round(Math.abs(value) * 100)}` : value.toFixed(2);
  function update() {
    select.value = time;
    for (const choice of timeChoices) choice.checked = choice.value === time;
    angle.value = indoor.angle;
    timeRoot.querySelector('output[for="lamp-angle"]').textContent = `${indoor.angle}°`;
    power.textContent = indoor.power ? '关灯' : '开灯';
    power.setAttribute('aria-pressed', String(indoor.power));
    if (power.getAttribute('role') === 'switch') {
      power.setAttribute('aria-checked', String(indoor.power));
      power.removeAttribute('aria-pressed');
      power.setAttribute('aria-label', lampName());
    } else power.setAttribute('aria-label', indoor.power ? '关闭室内灯' : '打开室内灯');
    power.disabled = !canLight;
    timeRoot.querySelector('#lamp-status').textContent = indoor.power ? '已开启' : '已关闭';
    const name = timeRoot.querySelector('#lamp-name');
    if (name) name.textContent = lampName();
    if (note) note.textContent = fixtures ? `灯光来自房间里的 ${fixtures} 盏顶灯，按灯具的位置照明；角度为完整光锥角度。白天弱补光，夜间主要照明，按房间记住角度与开关。` : centralNote;
    for (const input of ranges) {
      const key = input.dataset.grade; input.value = values[key];
      root.querySelector(`output[for="${input.id}"]`).textContent = format(key, values[key]);
    }
  }
  select.onchange = () => {time = timePreset(select.value); update(); onTime(time);};
  for (const choice of timeChoices) choice.onchange = () => {
    if (!choice.checked || select.disabled) return;
    select.value = choice.value; select.onchange();
  };
  angle.oninput = () => {
    indoor = indoorLighting({...indoor, angle: Number(angle.value)}); update(); onIndoor({...indoor});
  };
  power.onclick = () => {indoor = {...indoor, power: !indoor.power}; update(); onIndoor({...indoor});};
  for (const input of ranges) input.oninput = () => {
    values = colorGrading({...values, [input.dataset.grade]: Number(input.value)}); update(); onGrade({...values});
  };
  root.querySelector('#grading-reset').onclick = () => {values = colorGrading(DEFAULT_GRADING); update(); onGrade({...values});};
  update();
  return {
    setTime(value) {time = timePreset(value); update();},
    setIndoor(value) {indoor = indoorLighting(value); update();},
    setGrade(value) {values = colorGrading(value); update();},
    // How many ceiling luminaires light the room (0: the central lamp).
    setFixtures(count) {fixtures = count; update();},
    availability({time: canTime, grading: canGrade}) {
      select.disabled = !canTime;
      for (const choice of timeChoices) choice.disabled = !canTime;
      canLight = canTime;
      angle.disabled = power.disabled = !canLight;
      for (const input of ranges) input.disabled = !canGrade;
      root.querySelector('#grading-reset').disabled = !canGrade;
      root.querySelector('#grading-unavailable').hidden = canGrade;
    },
  };
}
