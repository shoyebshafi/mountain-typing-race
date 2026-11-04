// The climber: a human figure seen from behind, climbing a rock face on all four limbs.
// Every arm and leg is a two-bone limb solved with inverse kinematics, and the limbs follow a
// diagonal climbing gait (left hand + right foot move together, then right hand + left foot).
(function (root) {
  const SKIN_TONES = ['#f5d0b0', '#e8b98a', '#d39b6c', '#b97a4a', '#8d5a36', '#5e3a22'];
  const HAIR_COLORS = ['#14100d', '#2b1d14', '#5a3a22', '#8a5a2b', '#c9a15a', '#b5472a', '#9ca3af', '#f1f5f9'];
  const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#2563eb', '#7c3aed', '#db2777', '#f8fafc', '#475569', '#1f2937'];

  const OPTIONS = {
    hair: ['short', 'long', 'bun', 'buzz', 'bald'],
    outfit: ['jacket', 'hoodie', 'tshirt', 'sleeveless'],
    legs: ['long', 'shorts'],
    hat: ['none', 'beanie', 'cap', 'helmet'],
    pack: ['none', 'small', 'large']
  };
  const COLOR_KEYS = ['skin', 'hairColor', 'top', 'pants', 'shoes', 'hatColor', 'packColor'];

  const DEFAULT_AVATAR = {
    skin: '#e8b98a', hair: 'short', hairColor: '#2b1d14',
    outfit: 'jacket', top: '#2563eb', legs: 'long', pants: '#334155', shoes: '#1f2937',
    hat: 'beanie', hatColor: '#ef4444', pack: 'large', packColor: '#f97316'
  };

  // Players who have not designed a climber yet get a default one in their own colour.
  function defaultFor(color, index) {
    const skins = [1, 2, 0, 3, 4, 2, 5, 1];
    const hairs = ['short', 'long', 'buzz', 'bun', 'short', 'long', 'buzz', 'short'];
    const hats = ['beanie', 'cap', 'helmet', 'none', 'beanie', 'cap', 'helmet', 'none'];
    const i = (index || 0) % 8;
    return Object.assign({}, DEFAULT_AVATAR, {
      top: color || DEFAULT_AVATAR.top,
      skin: SKIN_TONES[skins[i]],
      hair: hairs[i],
      hat: hats[i],
      hatColor: PALETTE[(i * 3 + 1) % PALETTE.length],
      packColor: PALETTE[(i * 5 + 2) % PALETTE.length]
    });
  }

  const HEX = /^#[0-9a-fA-F]{6}$/;
  // Returns a clean avatar, or null if the input is not a valid avatar.
  function sanitize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out = {};
    for (const k of COLOR_KEYS) {
      if (typeof input[k] !== 'string' || !HEX.test(input[k])) return null;
      out[k] = input[k].toLowerCase();
    }
    for (const k of Object.keys(OPTIONS)) {
      if (OPTIONS[k].indexOf(input[k]) < 0) return null;
      out[k] = input[k];
    }
    return out;
  }

  // lighten (amt > 0) or darken (amt < 0) a #rrggbb colour
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => {
      const c = amt >= 0 ? v + (255 - v) * amt : v * (1 + amt);
      return Math.max(0, Math.min(255, Math.round(c)));
    };
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // ---------- gait ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const frac = (x) => x - Math.floor(x);

  const ARM = [16, 16];
  const LEG = [19, 19];
  const SHOULDER = [10, -26]; // half-width, y  (origin = middle of the hips)
  const HIP = [6, 0];
  const HAND_HI = [10, -61], HAND_LO = [14, -45];
  const FOOT_HI = [11, 17], FOOT_LO = [8, 35];

  // A limb cycle: first half it swings up to the next hold, second half it is planted and slides
  // back down relative to the body (because the body climbs). Returns 0 (low) .. 1 (high).
  function limbU(c) {
    return c < 0.5 ? smooth(c / 0.5) : 1 - (c - 0.5) / 0.5;
  }

  // two-bone inverse kinematics: where is the elbow / knee?
  function ik(sx, sy, tx, ty, l1, l2, bend) {
    let dx = tx - sx, dy = ty - sy;
    let d = Math.hypot(dx, dy);
    const max = l1 + l2 - 0.05;
    if (d > max) { dx *= max / d; dy *= max / d; d = max; tx = sx + dx; ty = sy + dy; }
    if (d < 1) { d = 1; }
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const mx = sx + (dx * a) / d, my = sy + (dy * a) / d;
    return { jx: mx + (bend * -dy * h) / d, jy: my + (bend * dx * h) / d, tx, ty };
  }

  // phase: gait cycle (any number, 1 = a full cycle). cheer: both arms up, waving. t: seconds.
  function computePose(phase, cheer, t) {
    let lh, rh, lf, rf;
    if (cheer) {
      const w = Math.sin((t || 0) * 9);
      lh = [-20, -63 + w * 3];
      rh = [20, -63 - w * 3];
      lf = [-9, 35];
      rf = [9, 35];
    } else {
      const uA = limbU(frac(phase));        // left hand + right foot
      const uB = limbU(frac(phase + 0.5));  // right hand + left foot
      lh = [-lerp(HAND_LO[0], HAND_HI[0], uA), lerp(HAND_LO[1], HAND_HI[1], uA)];
      rh = [lerp(HAND_LO[0], HAND_HI[0], uB), lerp(HAND_LO[1], HAND_HI[1], uB)];
      rf = [lerp(FOOT_LO[0], FOOT_HI[0], uA), lerp(FOOT_LO[1], FOOT_HI[1], uA)];
      lf = [-lerp(FOOT_LO[0], FOOT_HI[0], uB), lerp(FOOT_LO[1], FOOT_HI[1], uB)];
    }
    const la = ik(-SHOULDER[0], SHOULDER[1], lh[0], lh[1], ARM[0], ARM[1], -1);
    const ra = ik(SHOULDER[0], SHOULDER[1], rh[0], rh[1], ARM[0], ARM[1], 1);
    const ll = ik(-HIP[0], HIP[1], lf[0], lf[1], LEG[0], LEG[1], 1);
    const rl = ik(HIP[0], HIP[1], rf[0], rf[1], LEG[0], LEG[1], -1);
    const sway = cheer ? 0 : Math.sin(phase * Math.PI * 2) * 1.6;
    return { la, ra, ll, rl, sway, lean: cheer ? 0 : Math.sin(phase * Math.PI * 2) * 2.2 };
  }

  const f1 = (n) => Math.round(n * 10) / 10;

  function limbAttrs(l, sx, sy) {
    return {
      u: { x1: f1(sx), y1: f1(sy), x2: f1(l.jx), y2: f1(l.jy) },
      d: { x1: f1(l.jx), y1: f1(l.jy), x2: f1(l.tx), y2: f1(l.ty) }
    };
  }

  // Write the pose into an existing figure (used every animation frame).
  function applyPose(svg, pose) {
    const els = svg._els || (svg._els = {
      fig: svg.querySelector('.fig'),
      laU: svg.querySelector('.ua-l'), laD: svg.querySelector('.fa-l'), laH: svg.querySelector('.hand-l'),
      raU: svg.querySelector('.ua-r'), raD: svg.querySelector('.fa-r'), raH: svg.querySelector('.hand-r'),
      llU: svg.querySelector('.th-l'), llD: svg.querySelector('.sh-l'), llF: svg.querySelector('.shoe-l'),
      rlU: svg.querySelector('.th-r'), rlD: svg.querySelector('.sh-r'), rlF: svg.querySelector('.shoe-r')
    });
    const set = (el, o) => { el.setAttribute('x1', o.x1); el.setAttribute('y1', o.y1); el.setAttribute('x2', o.x2); el.setAttribute('y2', o.y2); };
    const limb = (U, D, H, l, sx, sy) => {
      const a = limbAttrs(l, sx, sy);
      set(U, a.u);
      set(D, a.d);
      H.setAttribute('cx', f1(l.tx));
      H.setAttribute('cy', f1(l.ty));
    };
    limb(els.laU, els.laD, els.laH, pose.la, -SHOULDER[0], SHOULDER[1]);
    limb(els.raU, els.raD, els.raH, pose.ra, SHOULDER[0], SHOULDER[1]);
    limb(els.llU, els.llD, els.llF, pose.ll, -HIP[0], HIP[1]);
    limb(els.rlU, els.rlD, els.rlF, pose.rl, HIP[0], HIP[1]);
    els.fig.setAttribute('transform', 'translate(' + f1(pose.sway) + ' 0) rotate(' + f1(pose.lean) + ' 0 0)');
  }

  // ---------- drawing ----------
  function limbMarkup(cls, upperColor, lowerColor, wU, wD, endTag) {
    return (
      '<line class="' + (cls === 'a' ? 'ua' : 'th') + '-SIDE" stroke="' + upperColor + '" stroke-width="' + wU + '" stroke-linecap="round"/>' +
      '<line class="' + (cls === 'a' ? 'fa' : 'sh') + '-SIDE" stroke="' + lowerColor + '" stroke-width="' + wD + '" stroke-linecap="round"/>' +
      endTag
    );
  }

  // Build the figure as an SVG string, already posed.
  function buildSvg(av, pose) {
    const a = av || DEFAULT_AVATAR;
    const skinDark = shade(a.skin, -0.2);
    const topDark = shade(a.top, -0.22);
    const topLight = shade(a.top, 0.16);
    const pantsDark = shade(a.pants, -0.22);
    const sleeveFull = a.outfit === 'jacket' || a.outfit === 'hoodie';
    const upperArm = a.outfit === 'sleeveless' ? a.skin : a.top;
    const lowerArm = sleeveFull ? a.top : a.skin;
    const lowerLeg = a.legs === 'shorts' ? a.skin : a.pants;

    const side = (html, s) => html.replace(/SIDE/g, s);
    const arm = (s) => side(limbMarkup('a', upperArm, lowerArm, 6.6, 5.8, '<circle class="hand-SIDE" r="3.3" fill="' + a.skin + '" stroke="' + skinDark + '" stroke-width=".6"/>'), s);
    const leg = (s) => side(limbMarkup('l', a.pants, lowerLeg, 7.6, 6.2, '<ellipse class="shoe-SIDE" rx="4.6" ry="3.2" fill="' + a.shoes + '"/>'), s);

    // torso, seen from behind
    let body = '<path d="M-11.5 -26.5 Q0 -32 11.5 -26.5 L9.8 2 Q0 5 -9.8 2 Z" fill="' + a.top + '"/>' +
      '<path d="M-11.5 -26.5 Q0 -32 11.5 -26.5 L10.6 -17 Q0 -13 -10.6 -17 Z" fill="' + topLight + '" opacity=".55"/>' +
      '<path d="M3 -28 L11.5 -26.5 L9.8 2 L3 3 Z" fill="' + topDark + '" opacity=".35"/>';
    if (a.outfit === 'hoodie') {
      body += '<ellipse cx="0" cy="-27" rx="7.4" ry="4.6" fill="' + topDark + '"/>' +
        '<path d="M-9 -9 H9 L8 -2 H-8 Z" fill="' + topDark + '" opacity=".5"/>';
    } else if (a.outfit === 'jacket') {
      body += '<path d="M-6 -28.5 Q0 -25 6 -28.5 L5 -24 Q0 -21 -5 -24 Z" fill="' + topDark + '"/>' +
        '<line x1="0" y1="-23" x2="0" y2="1" stroke="' + topDark + '" stroke-width="1" opacity=".7"/>' +
        '<line x1="-9.6" y1="-2" x2="9.6" y2="-2" stroke="' + topDark + '" stroke-width="1" opacity=".6"/>';
    } else if (a.outfit === 'sleeveless') {
      body += '<path d="M-6 -28 Q0 -24 6 -28" stroke="' + topDark + '" stroke-width="1.2" fill="none"/>';
    }
    // pelvis / waist in pants colour
    body += '<rect x="-9.8" y="-1.5" width="19.6" height="8" rx="3.2" fill="' + a.pants + '"/>' +
      '<rect x="-9.8" y="-1.5" width="19.6" height="2.2" rx="1" fill="' + pantsDark + '" opacity=".55"/>';

    // long hair falls behind the head over the back
    const hairBack = a.hair === 'long'
      ? '<path d="M-7.6 -38 Q-10 -22 -6.5 -12 Q0 -9 6.5 -12 Q10 -22 7.6 -38 Z" fill="' + a.hairColor + '"/>'
      : '';

    // backpack
    let pack = '';
    if (a.pack === 'small') {
      pack = '<rect x="-6.8" y="-25" width="13.6" height="15" rx="4.4" fill="' + a.packColor + '"/>' +
        '<rect x="-6.8" y="-25" width="13.6" height="5" rx="3" fill="' + shade(a.packColor, 0.22) + '"/>' +
        '<line x1="-6.8" y1="-15" x2="6.8" y2="-15" stroke="' + shade(a.packColor, -0.3) + '" stroke-width="1"/>';
    } else if (a.pack === 'large') {
      pack = '<rect x="-9.4" y="-33" width="18.8" height="4.6" rx="2.3" fill="' + shade(a.packColor, -0.35) + '"/>' +
        '<rect x="-9" y="-29.5" width="18" height="27" rx="5.2" fill="' + a.packColor + '"/>' +
        '<rect x="-9" y="-29.5" width="18" height="8" rx="4" fill="' + shade(a.packColor, 0.22) + '"/>' +
        '<line x1="-9" y1="-12" x2="9" y2="-12" stroke="' + shade(a.packColor, -0.3) + '" stroke-width="1.2"/>' +
        '<line x1="-4" y1="-21" x2="-4" y2="-4" stroke="' + shade(a.packColor, -0.3) + '" stroke-width=".9" opacity=".8"/>' +
        '<line x1="4" y1="-21" x2="4" y2="-4" stroke="' + shade(a.packColor, -0.3) + '" stroke-width=".9" opacity=".8"/>';
    }

    // head (we mostly see the back of it)
    let head = '<rect x="-2.6" y="-32" width="5.2" height="6" rx="2" fill="' + skinDark + '"/>' +
      '<circle cx="0" cy="-37" r="7" fill="' + a.skin + '"/>' +
      '<ellipse cx="-7" cy="-36.5" rx="1.5" ry="2.2" fill="' + skinDark + '"/><ellipse cx="7" cy="-36.5" rx="1.5" ry="2.2" fill="' + skinDark + '"/>';
    if (a.hair === 'short' || a.hair === 'long' || a.hair === 'bun') {
      head += '<path d="M-7.3 -35 A7.3 7.3 0 1 1 7.3 -35 Q6 -30.5 0 -30 Q-6 -30.5 -7.3 -35 Z" fill="' + a.hairColor + '"/>';
    } else if (a.hair === 'buzz') {
      head += '<path d="M-7.2 -35 A7.2 7.2 0 1 1 7.2 -35 Q6 -31 0 -30.5 Q-6 -31 -7.2 -35 Z" fill="' + a.hairColor + '" opacity=".7"/>';
    }
    if (a.hair === 'bun') head += '<circle cx="0" cy="-45.5" r="3.6" fill="' + a.hairColor + '"/>';

    // headwear
    let hat = '';
    if (a.hat === 'beanie') {
      hat = '<path d="M-7.9 -37 A7.9 7.9 0 0 1 7.9 -37 Z" fill="' + a.hatColor + '"/>' +
        '<rect x="-8.2" y="-38.2" width="16.4" height="4.4" rx="2" fill="' + shade(a.hatColor, -0.18) + '"/>' +
        '<circle cx="0" cy="-46.3" r="2.3" fill="' + shade(a.hatColor, 0.3) + '"/>';
    } else if (a.hat === 'cap') {
      hat = '<path d="M-7.6 -37.5 A7.6 7.6 0 0 1 7.6 -37.5 Z" fill="' + a.hatColor + '"/>' +
        '<rect x="-7.6" y="-38" width="15.2" height="2.2" rx="1" fill="' + shade(a.hatColor, -0.2) + '"/>' +
        '<rect x="-3" y="-36" width="6" height="2" rx="1" fill="' + shade(a.hatColor, 0.2) + '"/>';
    } else if (a.hat === 'helmet') {
      hat = '<path d="M-8.8 -36 A8.8 8.8 0 0 1 8.8 -36 Z" fill="' + a.hatColor + '"/>' +
        '<path d="M-8.8 -36 A8.8 8.8 0 0 1 8.8 -36 L8.8 -34.3 L-8.8 -34.3 Z" fill="' + shade(a.hatColor, -0.25) + '"/>' +
        '<line x1="0" y1="-44.6" x2="0" y2="-34.5" stroke="' + shade(a.hatColor, 0.4) + '" stroke-width="1.4" opacity=".7"/>' +
        '<rect x="-5" y="-41" width="3" height="1.6" rx=".8" fill="' + shade(a.hatColor, -0.3) + '"/><rect x="2" y="-41" width="3" height="1.6" rx=".8" fill="' + shade(a.hatColor, -0.3) + '"/>';
    }

    const svg =
      '<svg class="hiker-fig" viewBox="-30 -66 60 112" aria-hidden="true"><g class="fig">' +
      leg('l') + leg('r') +
      body + hairBack + pack +
      arm('l') + arm('r') +
      head + hat +
      '</g></svg>';
    const wrap = document_createSvg(svg);
    if (wrap) applyPose(wrap, pose || computePose(0.12, false, 0));
    return wrap ? wrap.outerHTML : svg;
  }

  // In the browser we pose the figure through the DOM; in node (tests) we return the raw string.
  function document_createSvg(markup) {
    if (typeof document === 'undefined') return null;
    const t = document.createElement('div');
    t.innerHTML = markup;
    return t.firstElementChild;
  }

  // Node/testing helper: pose the figure by editing the markup string.
  function buildSvgString(av, pose) {
    let s = buildSvg(av, null);
    const p = pose || computePose(0.12, false, 0);
    const put = (cls, o) => {
      s = s.replace(new RegExp('(class="' + cls + '")'), '$1 x1="' + o.x1 + '" y1="' + o.y1 + '" x2="' + o.x2 + '" y2="' + o.y2 + '"');
    };
    const ends = (cls, l, tag) => {
      s = s.replace(new RegExp('(class="' + cls + '")'), tag === 'c' ? '$1 cx="' + f1(l.tx) + '" cy="' + f1(l.ty) + '"' : '$1 cx="' + f1(l.tx) + '" cy="' + f1(l.ty) + '"');
    };
    const limb = (u, d, h, l, sx, sy) => {
      const a = limbAttrs(l, sx, sy);
      put(u, a.u); put(d, a.d); ends(h, l, 'c');
    };
    limb('ua-l', 'fa-l', 'hand-l', p.la, -SHOULDER[0], SHOULDER[1]);
    limb('ua-r', 'fa-r', 'hand-r', p.ra, SHOULDER[0], SHOULDER[1]);
    limb('th-l', 'sh-l', 'shoe-l', p.ll, -HIP[0], HIP[1]);
    limb('th-r', 'sh-r', 'shoe-r', p.rl, HIP[0], HIP[1]);
    return s.replace('<g class="fig">', '<g class="fig" transform="translate(' + f1(p.sway) + ' 0) rotate(' + f1(p.lean) + ' 0 0)">');
  }

  const api = {
    SKIN_TONES, HAIR_COLORS, PALETTE, OPTIONS, DEFAULT_AVATAR,
    defaultFor, sanitize, shade, computePose, applyPose, buildSvg, buildSvgString
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hiker = api;
})(typeof window !== 'undefined' ? window : this);
