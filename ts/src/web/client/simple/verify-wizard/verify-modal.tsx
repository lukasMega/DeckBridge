// Device verify wizard: one /api/verify session (lease kept alive while open), steps 0–9
// and the report. Flow and decisions: .claude/plans/2026-10-21_device-verify-wizard.md.
// Steps render in this scope rather than as components: they share all of its state.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  VerifySaveResponse,
  VerifySpec,
  VerifySpecResponse,
  VerifyStartResponse,
} from '../../../contract-verify.js';
import { ChipRadioGroup } from '../../components/ChipRadioGroup.js';
import { GhostButton } from '../../components/GhostButton.js';
import { Modal } from '../../components/Modal.js';
import { getSnapshot, useStore } from '../../lib/store.js';
import { fire, getJson, postJson, useFetched } from '../../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../../lib/ui-async.js';
import { copyLabel, useCopyText } from '../../lib/use-copy-text.js';
import { showToast } from '../../ui-helpers.js';
import type { DeviceOverridesView } from '../../ui-types.js';
import { buildBugReport } from '../bug-report-export.js';
import { KeymapLearn } from '../keymap-learn.js';
import { patternKeys, type PatternKind } from './pattern.js';
import {
  ORIENTATIONS,
  applyOrder,
  blankStart,
  blankStep,
  orderCandidates,
  orientationFix,
  sizeStart,
  sizeStep,
  splashToSave,
  tapOrder,
  type BlankState,
  type SizeAnswer,
  type SizeState,
} from './verify-math.js';
import { issueUrl, verifyReport, type VerifyAnswers } from './verify-report.js';
import {
  ASK,
  DeckPicture,
  MiniGrid,
  canDraw,
  changed,
  picture,
  tag,
  thumb,
  type VerifyImage,
} from './verify-steps.js';

const KEEPALIVE_MS = 10_000;
const FLOW = 'intro visible orient colours order size confirm real buttons result'.split(' ');
/** The session ends at the save in step 6 (confirm). */
const SAVE_AT = 6;
/** What steps 1–6 paint on entry, by FLOW index − 1. */
const PATTERN: PatternKind[] = ['index', 'index', 'rgb', 'index', 'rings', 'index'];

type Pictures = ReadonlyArray<readonly [string, ComponentChildren]>;

const end = (token: string | null): void => fire('/api/verify/end', { token });

/** Step heading and its hint line. */
const head = (q: ComponentChildren, hint?: string): preact.JSX.Element => (
  <>
    {q && <h3 class="survey-q">{q}</h3>}
    {hint && <p class="survey-hint">{hint}</p>}
  </>
);

/** Restart remounts a fresh run: new session, answers and drafts. */
export function VerifyWizard({
  dockIndex,
  onClose,
}: Readonly<{ dockIndex: number; onClose: () => void }>): preact.JSX.Element {
  const [run, setRun] = useState(0);
  return (
    <WizardRun
      key={run}
      dockIndex={dockIndex}
      onClose={onClose}
      onRestart={() => setRun(run + 1)}
    />
  );
}

function WizardRun({
  dockIndex,
  onClose,
  onRestart,
}: Readonly<{
  dockIndex: number;
  onClose: () => void;
  onRestart: () => void;
}>): preact.JSX.Element {
  const [drawable] = useState(canDraw);
  const [step, setStep] = useState('intro');
  // Step-local: blank ladder, re-check flag, taps, size ladder, redo or learn mode.
  const [sub, setSub] = useState<unknown>();
  const [spec, setSpec] = useState<VerifySpec | null>(null);
  const [image, setImage] = useState<VerifyImage | null>(null);
  const [order, setOrder] = useState<number[] | null>(null);
  const [answers, setAnswers] = useState<VerifyAnswers>({});
  const [ended, setEnded] = useState(false);
  const [saved, setSaved] = useState<VerifySaveResponse | null>(null);
  // The saved override, read after the save: learn mode merges into it, the report shows it.
  const [view, setView] = useState<DeviceOverridesView | null>(null);
  // Refs: paint and draft run right after start, before a re-render.
  const tokenRef = useRef<string | null>(null);
  const openRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const action = useAsyncAction();
  const copy = useCopyText();
  const endedMsg = useStore((s) => s.verifyEnded);
  // The intro's deck picture: the session (and its spec) starts only on Start.
  const preview = useFetched<VerifySpecResponse>(`/api/verify/spec?dock=${dockIndex}`).data;

  useEffect(function holdSession() {
    // Cancel, Escape and every other close unmount this: give the deck back.
    return function release() {
      openRef.current = false;
      clearInterval(timerRef.current);
      if (tokenRef.current) end(tokenRef.current);
    };
  }, []);

  useEffect(
    function watchEnded() {
      // Own ends (cancel, save) broadcast too; only these happen behind the client's back.
      const lost = endedMsg?.reason === 'lease' || endedMsg?.reason === 'detached';
      if (lost && endedMsg.dockIndex === dockIndex && tokenRef.current) {
        tokenRef.current = null;
        setEnded(true);
      }
    },
    [endedMsg, dockIndex],
  );

  const run = (fn: () => Promise<void>): void => void action.run(fn);
  const call = <T,>(path: string, body?: object): Promise<T> =>
    postJson<T>(`/api/verify/${path}`, { token: tokenRef.current, ...body }).catch((e: unknown) => {
      if ((e as { status?: number }).status === 410) {
        tokenRef.current = null;
        setEnded(true);
      }
      throw e;
    });
  const paint = async (s: VerifySpec, kind: PatternKind, o = order): Promise<void> => {
    const keys = patternKeys(kind, s, o ?? undefined);
    if (keys) await call('paint', { keys });
  };
  const go = (next: string, s = spec): void => {
    const i = FLOW.indexOf(next);
    setStep(next);
    setSub(undefined);
    if (!s) return;
    const kind = PATTERN[i - 1];
    if (kind) run(() => paint(s, kind));
    if (i > SAVE_AT + 1) {
      run(async () =>
        setView(await getJson<DeviceOverridesView>(`/api/device-overrides?modelId=${s.modelId}`)),
      );
    }
  };
  const start = (): void =>
    run(async () => {
      if (tokenRef.current) return go('visible');
      const r = await postJson<VerifyStartResponse>(
        '/api/verify/start',
        { dockIndex },
        'Could not start',
      );
      // Closed while starting: the release above had no token to end yet.
      if (!openRef.current) return end(r.token);
      tokenRef.current = r.token;
      timerRef.current = setInterval(() => {
        if (tokenRef.current) call('keepalive').catch(() => undefined);
      }, KEEPALIVE_MS);
      setSpec(r.spec);
      setImage(r.spec.image);
      go('visible', r.spec);
    });

  const at = FLOW.indexOf(step);
  // Key events come from the primary dock only; app frames may never have arrived.
  const skip = (s?: string): boolean =>
    (s === 'buttons' && dockIndex !== 0) || (s === 'real' && !spec?.hasAppFrames);
  const target = (by: number): number => {
    let i = at + by;
    while (skip(FLOW[i])) i += by;
    return i;
  };
  const next = (): void => go(FLOW[target(1)]!);
  const noBack = !at || ended || (saved ? target(-1) <= SAVE_AT : step === 'result');
  // Stages offered on this dock; ladders and follow-ups keep their stage's number.
  const stages = FLOW.filter((s) => !skip(s));
  const stage = stages.indexOf(step) + 1;
  const answer = (id: string, pick: string): void =>
    setAnswers((a) => ({ ...a, [id]: [...(a[id] ?? []), pick] }));

  /** One question (radio name `verify-q-<id>`); the pick goes into the report under `id`. */
  const ask = (
    id: string,
    onPick: (pick: string) => void,
    pictures: Pictures = [],
    hint?: string,
  ): preact.JSX.Element => {
    const [q, ...texts] = ASK[id]!.split('|');
    return (
      <>
        {head(q, hint)}
        <ChipRadioGroup
          name={`verify-q-${id}`}
          label={q!}
          value=""
          options={[
            ...pictures.map(([value, label]) => ({ value, label })),
            ...texts.map((t) => {
              const [value, label, pic] = t.split(':');
              return { value: value!, label: [picture(pic), label] };
            }),
          ]}
          onChange={(pick) => {
            answer(id, pick);
            onPick(pick);
          }}
        />
      </>
    );
  };

  const body = (): preact.JSX.Element => {
    if (!drawable) return head(null, "This browser can't draw test images.");
    if (ended)
      return (
        <>
          {head(null, 'Session ended. Your deck shows its normal images again.')}
          <GhostButton id="verify-restart" onClick={onRestart}>
            Start again
          </GhostButton>
        </>
      );
    if (!spec || !image || !at)
      return (
        <>
          {head(null, 'Your deck shows test images for a minute, then your app images return.')}
          {preview?.ok && <DeckPicture spec={preview.spec} />}
          <button class="ctabtn primary" id="verify-start" type="button" onClick={start}>
            Start
          </button>
        </>
      );
    const { rows, columns, keyCount } = spec;
    const img = changed(spec.image, image);
    const draft = async (patch: Partial<VerifyImage>): Promise<void> => {
      const nextImage = { ...image, ...patch };
      setImage(nextImage);
      await call('draft', { image: changed(spec.image, nextImage) });
    };
    /** Draft (if any), repaint this step's pattern, then ask the follow-up `then`. */
    const retry = (patch: Partial<VerifyImage> | null, then: unknown, o = order): void =>
      run(async () => {
        if (patch) await draft(patch);
        await paint(spec, PATTERN[at - 1]!, o);
        setSub(then);
      });
    // Blank ladder: still black at the last rung = nothing to save, so end now.
    const rung = (s: BlankState): void => {
      if (s.result === 'fixed') return next();
      if (!s.result) return retry(s.rungs[s.i]!, s);
      end(tokenRef.current);
      tokenRef.current = null;
      go('result');
    };
    // A re-pick is relative to the order already simulated.
    const reorder = (sigma: number[]): void => {
      const o = order ? applyOrder(order, sigma) : sigma;
      setOrder(o.every((v, i) => v === i) ? null : o);
      retry(null, 'check', o);
    };
    const taps = sub as number[];
    const sigma = Array.isArray(sub) && tapOrder(taps, keyCount);
    const candidates = orderCandidates(rows, columns);
    const ladder = sub as SizeState | undefined;
    // Key events are read at click time, as device tuning's bug report does.
    const report = (snap = getSnapshot()): string =>
      JSON.stringify(
        buildBugReport(
          view!,
          spec.appVersion,
          snap.keyEvents,
          snap.status.modelId,
          verifyReport(answers, {
            failed: !saved,
            imageChanged: !!order || Object.keys(img).some((k) => k !== 'width' && k !== 'height'),
            sizeChanged: 'width' in img,
          }),
        ),
        null,
        2,
      );

    const steps: Record<string, () => preact.JSX.Element> = {
      visible: () =>
        sub
          ? ask('blank', (pick) => rung(blankStep(sub as BlankState, pick === 'yes')))
          : ask('visible', (pick) => (pick === 'all' ? next() : rung(blankStart(image)))),
      orient: () =>
        sub
          ? ask('upright', (pick) => (pick === 'yes' ? next() : setSub(undefined)))
          : ask(
              'orient',
              (pick) => {
                const g = ORIENTATIONS.find((o) => tag(o) === pick)!;
                if (pick === '0') return next();
                retry({ ...orientationFix(image, spec.frameOrientation, g), flipV: false }, true);
              },
              ORIENTATIONS.map((g) => {
                const alt = `${g.rotate}°${g.flipH ? ' mirrored' : ''}`;
                const url = thumb('index', g.rotate, 1, g.flipH);
                // Without a canvas the caption stands in for the picture.
                return [
                  tag(g),
                  url ? <img key={alt} class="verify-thumb" src={url} alt={alt} /> : alt,
                ];
              }),
              'Look at the arrow and the F.',
            ),
      order: () => {
        if (sub === 'check')
          return ask('ordered', (pick) => (pick === 'yes' ? next() : setSub(undefined)));
        if (!Array.isArray(sub))
          return ask(
            'order',
            (pick) => {
              if (pick === 'tap') setSub([]);
              else if (pick === '0') next();
              else reorder(candidates[Number(pick)]!);
            },
            candidates.map((c, i) => [
              String(i),
              <MiniGrid key={c.join()} count={keyCount} columns={columns} at={(p) => c[p]!} />,
            ]),
          );
        return (
          <>
            {head(sigma ? 'All keys tapped' : `Tap where your deck shows ${taps.length + 1}`)}
            <MiniGrid
              count={keyCount}
              columns={columns}
              cls="verify-tap"
              at={(p) => taps.indexOf(p)}
              onTap={(p) =>
                setSub((t: unknown) => ((t as number[]).includes(p) ? t : [...(t as number[]), p]))
              }
            />
            <div class="settings-actions">
              <GhostButton onClick={() => setSub([])}>Start over</GhostButton>
              <GhostButton
                id="verify-tap-done"
                disabled={!sigma}
                onClick={() => sigma && reorder(sigma)}
              >
                Continue
              </GhostButton>
            </div>
          </>
        );
      },
      size: () =>
        ask('size', (pick) => {
          if (pick === 'other') return next();
          const s = sizeStep(ladder ?? sizeStart(image.width), pick as SizeAnswer);
          if (s.result === 'fail') answer('size', 'fail');
          // No size fits: back to the effective one.
          const size = s.result === 'fail' ? spec.image.width : s.size;
          const patch = size === image.width ? null : { width: size, height: size };
          if (!s.result) return retry(patch, s);
          run(async () => {
            if (patch) await draft(patch);
            next();
          });
        }),
      confirm: () =>
        sub
          ? ask('redo', go)
          : ask('confirm', (pick) =>
              pick === 'yes'
                ? run(async () => {
                    setSaved(
                      await call<VerifySaveResponse>('save', {
                        image: img,
                        coraToWireImage: order
                          ? applyOrder(spec.coraToWireImage, order)
                          : undefined,
                        splash: splashToSave(spec.image, image, spec.frameOrientation),
                      }),
                    );
                    tokenRef.current = null;
                    showToast('Saved');
                    next();
                  })
                : setSub(true),
            ),
      buttons: () =>
        sub ? (
          <>
            {view && (
              <KeymapLearn
                view={view}
                onSaved={() => {
                  answer('buttons', 'fixed');
                  next();
                }}
              />
            )}
            <GhostButton onClick={next}>Skip</GhostButton>
          </>
        ) : (
          ask('buttons', (pick) => (pick === 'no' ? setSub(true) : next()))
        ),
      result: () => (
        <>
          {saved
            ? head('Saved', 'Send the report to help others.')
            : head('Not fixed', 'Keys stayed black. Please send the report.')}
          <div class="settings-actions">
            <GhostButton id="verify-copy" disabled={!view} onClick={() => copy.copy(report())}>
              {copyLabel(copy.status, 'Copy report')}
            </GhostButton>
            <GhostButton
              id="verify-issue"
              disabled={!view}
              onClick={() => {
                const text = report();
                const link = issueUrl(spec, text);
                if (!link.withReport) {
                  void copy.copy(text);
                  showToast('Report copied: paste it in');
                }
                window.open(link.url, '_blank', 'noopener');
              }}
            >
              Open GitHub issue
            </GhostButton>
          </div>
        </>
      ),
    };
    // colours and real are only recorded.
    return (
      steps[step] ??
      (() =>
        ask(
          step,
          next,
          [],
          step === 'real' && saved?.reconnecting ? 'Wait for your deck to reconnect.' : undefined,
        ))
    )();
  };

  return (
    <Modal
      id="verify-wizard"
      class="survey"
      title="Check your deck"
      titleId="verify-title"
      onClose={onClose}
    >
      <label class="survey-progress">
        Step {stage} of {stages.length}
        <progress value={stage} max={stages.length} />
      </label>
      <fieldset class="survey-body verify-body" disabled={action.busy}>
        {body()}
        <Feedback error={ended ? null : action.error} status={null} />
      </fieldset>
      <div class="settings-actions survey-nav">
        <GhostButton
          id="verify-back"
          disabled={action.busy || noBack}
          onClick={() => go(FLOW[target(-1)]!)}
        >
          Back
        </GhostButton>
        <span class="grow" />
        <GhostButton id="verify-cancel" onClick={onClose}>
          {step === 'result' ? 'Done' : 'Cancel'}
        </GhostButton>
      </div>
    </Modal>
  );
}
