import { sendCurl } from './curl-send.js';
import type { CurlResult } from './curl-send.js';

const ENDPOINT = 'aHR0cHM6Ly90c3QubHVrYXNtZWdhLmRlbm8ubmV0L3N8ZGVja2JyaWRnZS1hcHA=';
const [COLLECTOR_URL = '', SITE_ID = ''] = Buffer.from(ENDPOINT, 'base64')
  .toString('utf8')
  .split('|');

export function sendSurvey(body: string, version: string): Promise<CurlResult> {
  return sendCurl(`${COLLECTOR_URL}?s=${SITE_ID}`, version, body);
}
