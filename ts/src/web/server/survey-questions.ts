import type { SurveyOption, SurveyQuestion } from '../contract-survey.js';

export const SURVEY_VERSION = 2;

function options(entries: [string, string][]): SurveyOption[] {
  return entries.map(([id, label]) => ({ id, label }));
}

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    id: 'rating',
    label: 'How do you like DeckBridge?',
    kind: 'single',
    faces: true,
    options: options([
      ['1', '😞'],
      ['2', '🙁'],
      ['3', '😐'],
      ['4', '🙂'],
      ['5', '😍'],
    ]),
  },
  {
    id: 'expect',
    label: 'Did it do what you expected?',
    kind: 'single',
    options: options([
      ['below', 'Less than expected'],
      ['met', 'What I expected'],
      ['above', 'More than expected'],
    ]),
  },
  {
    id: 'found',
    label: 'How did you find DeckBridge?',
    kind: 'single',
    options: [
      {
        id: 'search',
        label: 'Search engine',
        options: options([
          ['search-google', 'Google'],
          ['search-bing', 'Bing'],
          ['search-duckduckgo', 'DuckDuckGo'],
          ['search-brave', 'Brave'],
          ['search-ecosia', 'Ecosia'],
          ['search-other', 'Other search'],
        ]),
      },
      {
        id: 'ai',
        label: 'AI assistant',
        options: options([
          ['ai-chatgpt', 'ChatGPT'],
          ['ai-claude', 'Claude'],
          ['ai-perplexity', 'Perplexity'],
          ['ai-gemini', 'Gemini'],
          ['ai-copilot', 'Copilot'],
          ['ai-grok', 'Grok'],
          ['ai-other', 'Other AI'],
        ]),
      },
      {
        id: 'github',
        label: 'GitHub',
        options: options([
          ['github-search', 'GitHub search'],
          ['github-topic', 'Topic / trending / awesome list'],
          ['github-link', 'Linked from another repo'],
        ]),
      },
      ...options([
        ['reddit', 'Reddit'],
        ['youtube', 'YouTube / video'],
        ['forum', 'Forum / Discord'],
        ['friend', 'Friend / colleague'],
        ['article', 'Blog / article'],
        ['other', 'Other'],
      ]),
    ],
  },
  {
    id: 'why',
    label: 'Main reason you use it?',
    kind: 'single',
    options: options([
      ['no-dock', 'Skip buying a Network Dock'],
      ['cheap-deck', 'Non-Elgato deck in the Elgato app'],
      ['remote-pc', 'Deck on another computer'],
      ['phone-deck', 'Phone/tablet as a deck'],
      ['side-keys', "Keys/knobs the Elgato app can't use"],
      ['tinkering', 'Tinkering'],
      ['other', 'Other'],
    ]),
  },
  {
    id: 'use-for',
    label: 'What do you use it for?',
    kind: 'multi',
    options: options([
      ['streaming', 'Streaming'],
      ['productivity', 'Productivity'],
      ['development', 'Development'],
      ['music-audio', 'Music / audio'],
      ['video-photo', 'Video / photo'],
      ['gaming', 'Gaming'],
      ['home-automation', 'Home automation'],
      ['accessibility', 'Accessibility'],
      ['other', 'Other'],
    ]),
  },
  {
    id: 'features',
    label: 'Which features do you use?',
    kind: 'multi',
    options: options([
      ['multi-deck', 'Multiple decks'],
      ['side-keys', 'Side keys'],
      ['pages', 'Follow Elgato pages'],
      ['touch-strip', 'Knobs / touch strip'],
      ['standby', 'Standby / burn-in care'],
      ['browser-deck', 'Browser deck'],
      ['push-api', 'Push API'],
      ['device-tuning', 'Device tuning'],
      ['auto-restart', 'Elgato app auto-restart'],
      ['diagnostics', 'Bug report / diagnostics'],
      ['plugin-widgets', 'Plugin widgets'],
    ]),
  },
  {
    id: 'pain',
    label: 'What bothers you most?',
    kind: 'multi',
    max: 3,
    exclusive: 'nothing',
    options: options([
      ['setup', 'Setup / pairing'],
      ['disconnects', 'Disconnects'],
      ['image-lag', 'Slow key images'],
      ['image-quality', 'Image quality'],
      ['device-support', "My device isn't (fully) supported"],
      ['elgato-restart', 'Elgato app restarts'],
      ['security-warnings', 'Antivirus / Gatekeeper warnings'],
      ['permissions', 'macOS permissions'],
      ['webui', 'Web UI hard to use'],
      ['docs', 'Docs unclear'],
      ['nothing', 'Nothing 😊'],
    ]),
  },
  {
    id: 'want',
    label: 'What should come next?',
    kind: 'multi',
    max: 3,
    options: [
      ...options([
        ['home-assistant', 'Home Assistant'],
        ['widgets', 'Graphs / gauges'],
        ['knob-presets', 'Built-in knob / strip presets'],
        ['multi-host', 'One deck, several computers'],
        ['color-calibration', 'Color calibration'],
      ]),
      {
        id: 'more-devices',
        label: 'More devices',
        options: options([
          ['more-devices-mirabox', 'Mirabox'],
          ['more-devices-ajazz', 'Ajazz'],
          ['more-devices-ulanzi', 'Ulanzi'],
          ['more-devices-fifine', 'Fifine'],
          ['more-devices-elgato', 'Elgato'],
          ['more-devices-other', 'Other brand'],
        ]),
      },
      ...options([
        ['elgato-plugin', 'Control DeckBridge from the Elgato app'],
        ['settings-sync', 'Backup / sync'],
        ['linux-packages', 'Linux packages'],
        ['other', 'Other'],
      ]),
    ],
  },
  {
    id: 'nps',
    label: 'How likely are you to recommend DeckBridge to a friend?',
    kind: 'single',
    options: Array.from({ length: 11 }, (_, i) => ({ id: String(i), label: String(i) })),
    ends: ['Not likely', 'Very likely'],
  },
  {
    id: 'support',
    label: 'Would you support DeckBridge?',
    kind: 'single',
    options: options([
      ['sponsor', 'Monthly sponsor'],
      ['pay-once', 'Pay once for pro features'],
      ['share', 'Star / share it'],
      ['no', 'Not now'],
      ['already', 'Already do'],
    ]),
  },
];
