import type { SurveyQuestion } from '../../contract-survey.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { GhostButton } from '../components/GhostButton.js';
import { FaceLabel } from './survey-steps.js';

/** Banner under the topbar: the first survey question inline, so one tap starts the survey. */
export function SurveyNudge({
  rating,
  error,
  onRate,
  onNotNow,
  onNever,
}: Readonly<{
  rating: SurveyQuestion | undefined;
  error: string;
  onRate: (value: string) => void;
  onNotNow: () => void;
  onNever: () => void;
}>): preact.JSX.Element {
  return (
    <div class="warnrow survey-nudge" id="surveyNudge" role="region" aria-label="Feedback">
      <strong>How do you like DeckBridge?</strong>
      {rating && (
        <ChipRadioGroup
          name="nudge-rating"
          label={rating.label}
          value=""
          options={rating.options.map((o, i) => ({
            value: o.id,
            label: <FaceLabel face={o.label} index={i} />,
          }))}
          onChange={onRate}
        />
      )}
      <span class="grow" />
      <GhostButton onClick={onNotNow}>Not now</GhostButton>
      <GhostButton onClick={onNever}>Don't ask again</GhostButton>
      {error && <p class="settings-error">{error}</p>}
    </div>
  );
}
