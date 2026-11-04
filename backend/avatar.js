// Avatar ("climber look") validation. The browser has the same lists in frontend/js/hiker.js.
const OPTIONS = {
  hair: ['short', 'long', 'bun', 'buzz', 'bald'],
  outfit: ['jacket', 'hoodie', 'tshirt', 'sleeveless'],
  legs: ['long', 'shorts'],
  hat: ['none', 'beanie', 'cap', 'helmet'],
  pack: ['none', 'small', 'large']
};
const COLOR_KEYS = ['skin', 'hairColor', 'top', 'pants', 'shoes', 'hatColor', 'packColor'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Returns a clean avatar object, or null when the input is not a valid avatar.
function sanitizeAvatar(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const key of COLOR_KEYS) {
    if (typeof input[key] !== 'string' || !HEX.test(input[key])) return null;
    out[key] = input[key].toLowerCase();
  }
  for (const [key, allowed] of Object.entries(OPTIONS)) {
    if (!allowed.includes(input[key])) return null;
    out[key] = input[key];
  }
  return out;
}

module.exports = { sanitizeAvatar };
