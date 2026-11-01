// Recorre los flujos principales de AlmacénQR en un navegador simulado (jsdom)
// y comprueba que el stock y los movimientos quedan como deben.
// Uso: npm test
const fs = require('fs'), path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html.replace(/<script src=[^>]+><\/script>/g, ''), {
  runScripts: 'outside-only', url: 'https://demo.local/', pretendToBeVisual: true,
});
const w = dom.window;
w.qrcode = require('qrcode-generator');   // generador de QR (en la web viene del CDN)
w.jsQR = () => null;                       // la cámara no existe en jsdom
w.scrollTo = () => {};
const errores = [];
w.addEventListener('error', e => errores.push(e.message));

// El script de la app es el bloque <script> en línea más largo
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
w.eval(scripts.sort((a, b) => b.length - a.length)[0]);

const $ = s => w.document.querySelector(s);
const $$ = s => [...w.document.querySelectorAll(s)];
const click = el => { assert.ok(el, 'elemento no encontrado'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const simular = () => click($('.sim-ok'));
const escribir = (sel, v) => { const e = $(sel); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
const S = () => JSON.parse(w.localStorage.getItem('almacenqr-demo-v2'));
const stockEn = (sku, u) => S().stock[`${sku}|${u}`] || 0;

let ok = 0;
function prueba(nombre, fn) {
  try { fn(); ok++; console.log('  ✓ ' + nombre); }
  catch (e) { console.error('  ✗ ' + nombre + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('AlmacénQR · flujos');

prueba('la pantalla de inicio muestra las tareas pendientes', () => {
  assert.deepEqual($$('.tarea b').map(b => b.textContent), ['3', '2', '0']);
});

prueba('recepción de albarán: cuenta bultos y cierra con incidencia', () => {
  click($('[data-tarea="recepciones"]'));
  click($('[data-recep="ALB-2026-0431"]'));
  for (let i = 0; i < 3; i++) { click($('#rc-scan')); simular(); }
  click($('#rc-ok'));
  const r = S().recepciones[0];
  assert.equal(r.estado, 'recibido');
  assert.match(r.incidencia, /CIL-HID-EL 1\/6/);
  assert.equal(stockEn('ELV-TIJ-3T', 'MUELLE-ENT'), 2);
});

prueba('preparación de pedido: ruta completa hasta expedición', () => {
  click($('[data-ttab="pedidos"]'));
  click($('[data-pedido="PED-1201"]'));
  for (let v = 0; v < 20 && !$('#btn-expedir'); v++) {
    if ($('#pk-scan')) { click($('#pk-scan')); simular(); } else click($('#pk-ok'));
  }
  assert.equal(S().pedidos.find(p => p.id === 'PED-1201').estado, 'preparado');
  assert.equal(stockEn('KIT-ANC-M16', 'EXPED'), 8);
  click($('#btn-expedir'));
  assert.equal(S().pedidos.find(p => p.id === 'PED-1201').estado, 'expedido');
  assert.ok(!Object.keys(S().stock).some(k => k.endsWith('|EXPED')), 'expedición debería quedar vacía');
});

prueba('avisa si se escanea la estantería equivocada', () => {
  click($('[data-pedido="PED-1202"]'));
  click($('#pk-scan'));
  $('#manual').value = 'A-06-3'; click($('#manual-ok'));
  assert.match($('.toast').textContent, /Estantería equivocada/);
  click($('.sheet .x'));
});

prueba('inventario a ciegas: detecta la diferencia y ajusta el stock', () => {
  click($('[data-go="tareas"]')); click($('[data-ttab="inventario"]'));
  click($('#btn-inv')); simular();
  escribir('.sheet input[data-sku]', '50');
  click($('#inv-cmp'));
  assert.match($('.sheet .hint').textContent, /1 diferencia/);
  click($('#inv-ok'));
  assert.equal(stockEn('KIT-ANC-M16', 'C-04-3'), 50);
  assert.equal(S().movs[0].tipo, 'ajuste');
});

prueba('panel, mapa y hoja de etiquetas', () => {
  click($('[data-go="panel"]'));
  assert.equal($$('.chart rect').length, 14);
  click($('[data-go="stock"]')); click($('[data-smodo="mapa"]'));
  assert.equal($$('.slot').length, 54);
  click($('[data-smodo="lista"]'));
  click([...w.document.querySelectorAll('button')].find(b => b.textContent.includes('Etiquetas QR')));
  assert.equal($$('.label').length, 14);
});

prueba('producto nuevo: no admite referencias repetidas', () => {
  click($('[data-go="stock"]')); click($('[data-nuevoprod]'));
  escribir('#np-sku', 'ELV-2C-4T'); escribir('#np-nom', 'Prueba');
  click($('#np-ok'));
  assert.match($('#np-err').textContent, /Ya existe/);
});

prueba('producto nuevo: alta + entrada + etiqueta QR que se puede escanear', () => {
  escribir('#np-sku', 'elv 2c 5t');
  assert.equal($('#np-sku').value, 'ELV-2C-5T');
  escribir('#np-nom', 'Elevador 2 columnas 5.000 kg');
  $('#np-qty').value = '3'; $('#np-ref').value = 'ALB-2026-0440';
  const destino = $('#np-a').value;
  click($('#np-ok'));
  assert.equal(stockEn('ELV-2C-5T', destino), 3);
  assert.equal(S().movs[0].ref, 'ALB-2026-0440');
  assert.equal($('#el-cop').value, '3');
  assert.ok($('.sheet .label svg'), 'falta el QR de la etiqueta');
  click($('.sheet .x'));
  click($('[data-go="escanear"]'));
  $('#manual').value = 'AQR:P:ELV-2C-5T'; click($('#manual-ok'));
  assert.equal($('.sheet h3').textContent, 'Elevador 2 columnas 5.000 kg');
});

prueba('sin errores de JavaScript', () => assert.deepEqual(errores, []));

console.log(`\n${ok} pruebas correctas${process.exitCode ? ' · HAY FALLOS' : ''}`);
