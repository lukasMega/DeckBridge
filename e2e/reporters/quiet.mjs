// Silent on success: prints only failures and one summary line.
export default class QuietReporter {
  #failed = [];
  #passed = 0;
  #skipped = 0;

  printsToStdio() {
    return true;
  }

  onTestEnd(test, result) {
    if (result.status === 'skipped') this.#skipped++;
    else if (result.status === test.expectedStatus) this.#passed++;
    else this.#failed.push({ test, result });
  }

  onEnd() {
    for (const { test, result } of this.#failed) {
      console.log(`✘ ${test.titlePath().filter(Boolean).join(' › ')}`);
      for (const e of result.errors) console.log(e.stack ?? e.message ?? String(e));
    }
    const skipped = this.#skipped ? `, ${this.#skipped} skipped` : '';
    console.log(
      this.#failed.length
        ? `✘ e2e: ${this.#failed.length} failed, ${this.#passed} passed${skipped}`
        : `✔ e2e (${this.#passed} passed${skipped})`,
    );
  }
}
