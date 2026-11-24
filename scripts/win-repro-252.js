// Repro for issue #252: cmd /c `if exist "<path>"` via tjs.spawn vs tjs.stat on Windows.
const isWin = tjs.env.OS === 'Windows_NT';
const sep = isWin ? '\\' : '/';

async function run(argv, pipe) {
  const p = tjs.spawn(argv, { stdout: pipe ? 'pipe' : 'ignore', stderr: pipe ? 'pipe' : 'ignore' });
  let out = '';
  if (pipe) {
    const buf = new Uint8Array(4096);
    for (let n; (n = await p.stdout.read(buf)) > 0; ) out += new TextDecoder().decode(buf.subarray(0, n));
  }
  const { exit_status } = await p.wait();
  return { exit_status, out };
}

// exact copy of requirements.ts fileExists
async function oldExists(path) {
  const argv = isWin
    ? ['cmd', '/c', `if exist "${path}" (exit 0) else (exit 1)`]
    : ['test', '-f', path];
  try {
    return (await run(argv, false)).exit_status === 0;
  } catch {
    return null;
  }
}

async function statExists(path) {
  try {
    const st = await tjs.stat(path);
    return { ok: true, isFile: st.isFile };
  } catch (e) {
    return { ok: false, err: String(e && e.message) };
  }
}

const base = tjs.env.LOCALAPPDATA ?? tjs.env.TMPDIR ?? '/tmp';
const root = `${base}${sep}deckbridge-repro-${Date.now()}`;
await tjs.makeDir(`${root}${sep}sub dir`, { recursive: true });
await tjs.makeDir(`${root}${sep}deckbridge`, { recursive: true });
const enc = new TextEncoder();
for (const f of ['a.txt', 'sub dir/b.txt', 'deckbridge/c.dll']) {
  const h = await tjs.open(`${root}${sep}${f.replaceAll('/', sep)}`, 'w');
  await h.write(enc.encode('x'));
  await h.close();
}

const cases = [
  ['backslash', `${root}${sep}a.txt`],
  ['mixed \\ and /', `${root}/deckbridge/c.dll`],
  ['space', `${root}${sep}sub dir${sep}b.txt`],
  ['missing backslash', `${root}${sep}nope.txt`],
  ['missing mixed', `${root}/deckbridge/nope.dll`],
];

console.log('isWin:', isWin, 'tjs', tjs.version);
let bad = 0;
for (const [name, path] of cases) {
  const missing = name.startsWith('missing');
  const o = await oldExists(path);
  const s = await statExists(path);
  const sOk = missing ? !s.ok : s.ok && s.isFile;
  if (!sOk) bad++;
  console.log(`\n== ${name}: ${path}`);
  console.log(`  old fileExists : ${o}`);
  console.log(`  tjs.stat       : ${JSON.stringify(s)}  ${sOk ? 'OK' : 'WRONG'}`);
  if (isWin) {
    // same argv shape as the old call, plus an echo of what cmd itself received
    const probe = await run(
      ['cmd', '/c', `if exist "${path}" (echo EXIST) else (echo NOTEXIST)& echo [%cmdcmdline%]`],
      true,
    );
    console.log(`  probe (same quoting, stdout): ${JSON.stringify(probe.out.trim())}`);
  }
}
await tjs.remove(root).catch(() => {});
console.log(bad ? `\nFAIL: tjs.stat wrong in ${bad} case(s)` : '\nOK: tjs.stat correct in all cases');
tjs.exit(bad ? 1 : 0);
