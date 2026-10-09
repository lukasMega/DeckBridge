import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Check both transitive entry points used by ESLint's boundaries plugin.
const pluginRequire = createRequire(
  createRequire(import.meta.url).resolve('eslint-plugin-boundaries'),
);
const elementsRequire = createRequire(pluginRequire.resolve('@boundaries/elements'));
const copies = new Set([
  pluginRequire.resolve('handlebars'),
  elementsRequire.resolve('handlebars'),
]);

for (const modulePath of copies) {
  const Handlebars = pluginRequire(modulePath);

  test('Handlebars rejects injected AST block parameters (CVE-2026-106446)', () => {
    const ast = Handlebars.parse('{{#missingHelper}}ok{{/missingHelper}}');
    ast.body[0].program.blockParams = {
      length: '(()=>{throw new Error("Injected JavaScript executed")})()',
    };
    assert.throws(() => Handlebars.compile(ast)({}), /Invalid.*blockParams/);
    assert.throws(() => Handlebars.precompile(ast), /Invalid.*blockParams/);
  });

  test('Handlebars blocks own constructor on prototypes (CVE-2026-106445)', () => {
    const env = Handlebars.create();
    let captured;
    env.registerHelper('capture', (value) => {
      captured = value;
      return '';
    });
    env.compile('{{capture (lookup (lookup fn "__proto__") "constructor")}}')(
      { fn() {} },
      { allowProtoMethodsByDefault: true },
    );
    assert.equal(captured, undefined);
    assert.equal(env.compile('{{name}}')({ name: 'safe' }), 'safe');
  });

  test('Handlebars escapes precompiled inline script text (CVE-2026-106444)', () => {
    const source = 'safe</script><script>void 0</script>';
    const compiled = Handlebars.precompile(source);
    assert.equal(compiled.toLowerCase().includes('</script>'), false);
    // Runs the library's own precompile output; the test needs to execute it.
    // eslint-disable-next-line sonarjs/code-eval
    const specification = runInNewContext(`(${compiled})`);
    assert.equal(Handlebars.template(specification)({}), source);
  });
}
