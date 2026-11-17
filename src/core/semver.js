'use strict';
// Minimal semver: parse / compare / satisfies. Supports exact, x-ranges,
// ^, ~, >, >=, <, <=, space-joined comparator sets and `||` unions.

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v) {
  const m = RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function valid(v) {
  return parse(v) !== null;
}

function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // release > prerelease
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// Expand one comparator token into [op, version] pairs.
function expand(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?([\dxX*]+)(?:\.([\dxX*]+))?(?:\.([\dxX*]+))?(?:-([0-9A-Za-z.-]+))?$/.exec(token);
  if (!m) throw new Error(`Invalid range token: ${token}`);
  const op = m[1] || '';
  const isX = (s) => s === undefined || /^[xX*]$/.test(s);
  const [M, mi, p] = [m[2], m[3], m[4]];
  const pre = m[5] ? `-${m[5]}` : '';
  if (isX(M)) return [];
  const maj = +M;
  if (isX(mi)) {
    if (op === '' || op === '=' || op === '^' || op === '~') return [['>=', `${maj}.0.0`], ['<', `${maj + 1}.0.0-0`]];
    if (op === '>') return [['>=', `${maj + 1}.0.0`]];
    if (op === '<=') return [['<', `${maj + 1}.0.0-0`]];
    return [[op, `${maj}.0.0`]];
  }
  const min = +mi;
  if (isX(p)) {
    if (op === '' || op === '=' || op === '~') return [['>=', `${maj}.${min}.0`], ['<', `${maj}.${min + 1}.0-0`]];
    if (op === '^') {
      return maj > 0
        ? [['>=', `${maj}.${min}.0`], ['<', `${maj + 1}.0.0-0`]]
        : [['>=', `0.${min}.0`], ['<', `0.${min + 1}.0-0`]];
    }
    if (op === '>') return [['>=', `${maj}.${min + 1}.0`]];
    if (op === '<=') return [['<', `${maj}.${min + 1}.0-0`]];
    return [[op, `${maj}.${min}.0`]];
  }
  const v = `${maj}.${min}.${+p}${pre}`;
  if (op === '^') {
    if (maj > 0) return [['>=', v], ['<', `${maj + 1}.0.0-0`]];
    if (min > 0) return [['>=', v], ['<', `0.${min + 1}.0-0`]];
    return [['>=', v], ['<', `0.0.${+p + 1}-0`]];
  }
  if (op === '~') return [['>=', v], ['<', `${maj}.${min + 1}.0-0`]];
  return [[op || '=', v]];
}

function test(op, v, target) {
  const c = compare(v, target);
  switch (op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    default: return false;
  }
}

function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const r = String(range || '*').trim();
  if (r === '' || r === '*' || r === 'x') return true;
  return r.split('||').some((set) => {
    const tokens = set.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return tokens.every((t) => expand(t).every(([op, target]) => test(op, v, target)));
  });
}

function validRange(range) {
  try {
    satisfies('0.0.0', range);
    return true;
  } catch {
    return false;
  }
}

module.exports = { parse, valid, compare, satisfies, validRange };
