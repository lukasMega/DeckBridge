import assert from 'tjs:assert';
import { test, summary } from './helpers/harness.js';

let decoratedClass: Function | undefined;

function markClass(value: Function, context: ClassDecoratorContext) {
  assert.equal(context.name, 'Example');
  decoratedClass = value;
}

function doubleResult(
  original: (this: Example, amount: number) => number,
  context: ClassMethodDecoratorContext<Example, (amount: number) => number>,
) {
  assert.equal(context.name, 'add');
  return function (this: Example, amount: number) {
    return original.call(this, amount) * 2;
  };
}

@markClass
class Example {
  total = 1;

  @doubleResult
  add(amount: number) {
    return this.total + amount;
  }
}

test('class and method decorators run under slim tjs', () => {
  assert.equal(decoratedClass, Example);
  assert.equal(new Example().add(2), 6);
});

summary();
