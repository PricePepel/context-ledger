// W2: builds rules/secret-conformance.json from the ledger scanner. Usage: node scripts/make-secret-conformance.mjs .
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const { findSecrets } = await import(pathToFileURL(join(root, 'src/secrets.mjs')).href);

const r = (unit, times) => ({ repeat: unit, times });
const nl = { char: 10 };
const cr = { char: 13 };
const tab = { char: 9 };
const ls = { char: 0x2028 };
const bs = { char: 92 };
const pemType = ['RSA ', 'PRIVATE KEY'];
const ecType = ['EC ', 'PRIVATE KEY'];

const fake = {
  aws: ['AK', 'IA', 'Q3XZ7W2M9KD4PL6N'],
  asia: ['AS', 'IA', 'Z9Y8X7W6V5U4T3S2'],
  ghp: ['gh', 'p_', r('Ab3D', 9)],
  gho: ['gh', 'o_', r('Zz9y', 9)],
  pat: ['github', '_pat_', r('11AB', 6), '_', r('cD9e', 10)],
  ant: ['sk', '-ant-', 'api03-', r('Zq7W', 10)],
  oai: ['sk', '-proj-', r('Hk4t', 10)],
  oaiPlain: ['sk', '-', r('aB3d', 8)],
  oaiWord: ['sk', '-', r('learning', 4)],
  slack: ['xo', 'xb-', '1234567890-', r('aB1c', 5)],
  stripe: ['sk', '_live_', r('Rf5G', 6)],
  stripeTest: ['rk', '_test_', r('Pq2W', 5)],
  jwt: ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpM'],
  jwtNoSig: ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.'],
  awsSecret: r('wJal', 10),
  bearer: r('Tq8z', 8),
};

const cases = [
  // simple key formats
  { name: 'aws access key id', text: ['key ', ...fake.aws, ' here'] },
  { name: 'asia access key id', text: ['id=', ...fake.asia] },
  { name: 'aws id followed by a letter is not one', text: ['x ', ...fake.aws, 'z'] },
  { name: 'github classic token', text: ['push with ', ...fake.ghp, '.'] },
  { name: 'github oauth token', text: [...fake.gho] },
  { name: 'github fine-grained token', text: ['pat ', ...fake.pat] },
  { name: 'anthropic key', text: ['ANTHROPIC_API_KEY ', ...fake.ant] },
  { name: 'openai project key', text: ['use ', ...fake.oai, ' now'] },
  { name: 'openai plain key', text: ['k=', ...fake.oaiPlain] },
  { name: 'a long hyphenated word after sk- is no key', text: ['see ', ...fake.oaiWord] },
  { name: 'slack token', text: ['bot ', ...fake.slack] },
  { name: 'stripe live key', text: [...fake.stripe, ','] },
  { name: 'stripe restricted test key', text: ['(', ...fake.stripeTest, ')'] },
  { name: 'a token glued to a word is not found', text: ['abc', ...fake.ghp] },
  { name: 'two keys on one line', text: [...fake.ghp, ' and ', ...fake.slack] },
  // jwt
  { name: 'jwt', text: ['token: ', ...fake.jwt, ' end'] },
  { name: 'jwt with an empty signature', text: [...fake.jwtNoSig, ' x'] },
  { name: 'a lone jwt header is no jwt', text: ['ey', 'JhbGciOiJIUzI1NiJ9 only'] },
  // private keys
  { name: 'rsa private key block', text: ['-----BEGIN ', ...pemType, '-----', nl, 'MIIEowIBAAKCAQEA', r('q1W2', 16), nl, '-----END ', ...pemType, '-----', nl, 'after'] },
  { name: 'private key with headers and a blank line', text: ['-----BEGIN ', ...ecType, '-----', nl, 'Proc-Type: 4,ENCRYPTED', nl, 'DEK-Info: AES-128-CBC,00', nl, nl, r('Ab12', 16), nl, '-----END ', ...ecType, '-----'] },
  { name: 'unfinished private key stops at prose', text: ['-----BEGIN ', ...pemType, '-----', nl, r('Zx90', 8), nl, 'This is prose, not base64.', nl, 'more'] },
  { name: 'crlf private key', text: ['-----BEGIN ', ...pemType, '-----', cr, nl, r('Qw12', 8), cr, nl, '-----END ', ...pemType, '-----', cr, nl] },
  // value after a name
  { name: 'aws secret access key', text: ['aws_secret_access_key = ', ...[fake.awsSecret]] },
  { name: 'aws secret access key quoted', text: ['"aws_secret_access_key": "', fake.awsSecret, '"'] },
  { name: 'aws secret access key of the wrong length', text: ['aws_secret_access_key=', r('wJal', 9)] },
  { name: 'aws secret inside a quoted assignment with escapes', text: ['"AWS_SECRET_ACCESS_KEY=', r('wJal', 5), bs, 'u0041', r('wJal', 4), 'abc', '"'] },
  // free text
  { name: 'password after a name', text: ['password=hunter2', 'Zq', nl, 'next line'] },
  { name: 'password in yaml', text: ['db:', nl, '  password: "s3cr3t-', 'Value"', nl, '  user: app'] },
  { name: 'api key with a prefix name', text: ['MY_API_KEY=abc', '123def456', ' # note'] },
  { name: 'client secret with a space', text: ['client secret: ', 'Pp9', 'Qq8Rr7'] },
  { name: 'token placeholder digits', text: ['token=12345'] },
  { name: 'password placeholder changeme', text: ['password: changeme'] },
  { name: 'password placeholder env var', text: ['password=${DB_PASSWORD}'] },
  { name: 'password placeholder angle stand-in', text: ['api_key: <your-key-here>'] },
  { name: 'angle value that is not a stand-in', text: ['api_key: <monkey9>'] },
  { name: 'password placeholder stars', text: ['secret = ********'] },
  { name: 'password placeholder process env', text: ['token: process.env.API_TOKEN'] },
  { name: 'quoted placeholder followed by text', text: ['password="changeme"', 'synthetic9'] },
  { name: 'quoted placeholder followed by a comma', text: ['{"password": "changeme", "user": "x"}'] },
  { name: 'redacted placeholder', text: ['token: [REDACTED github-token]'] },
  { name: 'uuid placeholder', text: ['token=123e4567-e89b-12d3-a456-426614174000'] },
  { name: 'bearer header', text: ['Authorization: Bearer ', fake.bearer, nl, 'Accept: */*'] },
  { name: 'bearer header quoted', text: ['"Authorization": "Bearer ', fake.bearer, '"'] },
  { name: 'bearer with tabs', text: ['authorization:', tab, 'bearer', tab, fake.bearer] },
  { name: 'free text ends at a unicode line separator', text: ['password=abc', 'Def9', ls, 'visible'] },
  { name: 'a key inside a free-text value merges', text: ['token: x ', ...fake.ghp, ' y'] },
  { name: 'no secret at all', text: ['The answer is 42. Nothing secret here; sk is a prefix.'] },
  { name: 'passwordless prose', text: ['The password policy is strict.'] },
  { name: 'empty value', text: ['password='] },
  { name: 'non-ascii text around a key', text: ['caf', { char: 0xe9 }, ' ', ...fake.ghp, ' ', { char: 0x4e2d }] },
  { name: 'several leads on one line', text: ['password=aa', 'Bb11 token=cc', 'Dd22'] },
  // Unicode folding and whitespace, which both sides must read as JavaScript's iu flags do
  { name: 'long s folds to s in a lead', text: ['pa', { char: 0x17f }, { char: 0x17f }, 'word=hunter2', 'Zq'] },
  { name: 'kelvin sign folds to k in a lead', text: ['aws_secret_access_', { char: 0x212a }, 'ey=', fake.awsSecret] },
  { name: 'no-break spaces around the equals sign', text: ['aws_secret_access_key', { char: 0xa0 }, '=', { char: 0xa0 }, fake.awsSecret] },
  { name: 'a dotted capital i is no word character', text: [{ char: 0x130 }, 'token=abcd', '1234xyz'] },
  { name: 'a dotless i does not fold into a stand-in', text: ['token=opt', { char: 0x131 }, 'onal'] },
  { name: 'a dotted capital i does not fold into a lead', text: ['AP', { char: 0x130 }, '_KEY=abcd', '1234xyz'] },
  { name: 'a dotless i does not fold into a lead', text: ['pass', 'word', ' ', 'p', { char: 0x131 }, 'n=abc', '123Def'] },
  { name: 'upper case lead and stand-in', text: ['PASSWORD=CHANGEME', { char: 10 }, 'TOKEN: Abc123', 'Def456'] },
  // W2 review round 14: a value is judged a stand-in only up to placeholders.maxJudged
  // characters (4,096), so judging stays bounded; a longer run of digits is a value.
  { name: 'digits up to the stand-in bound are a stand-in', text: ['password=', r('0', 4096)] },
  { name: 'digits past the stand-in bound are a value', text: ['password=', r('0', 4097)] },
];

function expand(parts) {
  return parts.map(part => typeof part === 'string' ? part
    : part.repeat !== undefined ? part.repeat.repeat(part.times) : String.fromCodePoint(part.char)).join('');
}

function codePoints(text, index) {
  return [...text.slice(0, index)].length;
}

const out = {
  about: 'Cases both scanners run: src/secrets.mjs (tests/secret-rules.test.mjs) and runtime/latent_team/secret_scan.py (runtime/tests/test_secret_rules.py). A text is a list of parts joined in order: a string, {repeat, times} or {char: code point}, so no committed file holds a whole string in a credential format. Expected spans count code points. Built from the ledger scanner (the P4b and P4c rules) on 2026-11-22.',
  cases: cases.map(({ name, text }) => {
    const full = expand(text);
    return {
      name,
      text,
      spans: findSecrets(full).map(f => ({ kind: f.kind, start: codePoints(full, f.start), end: codePoints(full, f.end), prefix: f.prefix })),
    };
  }),
};
writeFileSync(join(root, 'rules/secret-conformance.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out.cases.map(c => `${c.name}: ${c.spans.map(s => s.kind).join(',') || '-'}`).join('\n'));
