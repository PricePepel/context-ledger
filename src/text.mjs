const escapeCodeUnits = character => [...Array(character.length).keys()]
  .map(index => '\\u' + character.charCodeAt(index).toString(16).padStart(4, '0'))
  .join('');

// ZWNJ and ZWJ are format characters that emoji and some scripts need to render.
const keptFormatCharacters = new Set([0x200c, 0x200d]);

// Handoff text is shown to people and agents. Escape controls, bidi overrides and
// invisible tag characters so transcript text cannot spoof or hide what it says.
export function visibleText(text) {
  return text.replace(/\r\n/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, character => {
    if (character === '\n' || character === '\t') return character;
    if (keptFormatCharacters.has(character.codePointAt(0))) return character;
    return escapeCodeUnits(character);
  });
}

// A single-line variant for labels: line breaks and tabs are escaped too.
export function inlineText(text) {
  return visibleText(text).replace(/[\n\t]/g, escapeCodeUnits);
}

// JSON.stringify leaves DEL, C1 controls, bidi/format characters and U+2028/9 raw.
// Escaping them keeps the output valid, lossless JSON that cannot drive a terminal.
export function terminalJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => {
    if (character === '\n') return character;
    return escapeCodeUnits(character);
  });
}
