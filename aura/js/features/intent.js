/**
 * AURA :: feature popup intent parser (ONE function for every surface)
 * =====================================================================
 * "Hey Aura, create a ppt on Mars for my holiday homework" → the PPT Builder
 * popup, topic + audience prefilled. Typed input, wake-word commands and STT
 * finals all call THIS function (see main.js maybeFeatureIntent); nothing
 * else re-implements the phrasing rules.
 *
 * Parsing order: strip lead/courtesy → reject questions → kind →
 * details ("with …") → audience ("for …") → topic ("on/about/of …").
 *
 * @module features/intent
 */
import { splitAudience } from './kit.js';

const DOC_WORDS = /(ppt|pptx|power\s*point|powerpoint|slide\s*deck|presentation|decks?|slides?|xlsx|excel|spread\s*sheet|spreadsheet|workbook|sheets?|docx|word\s*doc|word\s*document|report|essay|letter)/gi;
const ACTION = /\b(make|create|build|generate|prepare|write|draft|give|design|do|start)\b/i;
const QUESTION = /^\s*(what|how|when|where|why|who|is|are|can|do|does|should|explain|tell|show)\b/i;
const LEAD = /^\s*(hey|ok(?:ay)?|please)\s+(aura|nova|jarvis|mycroft)\s*[,!. ]*\s*/i;
const COURTESY = /^\s*(please\s+)?(can|could|will|would|do|shall)\s+you\s+/i;
const RESEARCH_VERB = /^(research|browse|look\s*up|search\s*(the\s*)?web|study)\s+/i;

/**
 * Parse a direct request into a feature popup.
 * @param {string} text
 * @returns {null | {kind:'pptx'|'docx'|'xlsx'|'research',
 *                   prefill:{topic:string, audience:string, details:string}}}
 */
export function parseFeatureIntent(text) {
  let t = String(text || '').trim();
  if (!t || t.startsWith('/')) return null;
  t = t.replace(LEAD, ' ').replace(COURTESY, ' ').replace(/\s+/g, ' ').trim();
  if (QUESTION.test(t)) return null;

  let kind = null;
  const docVerbs = ACTION.test(t);
  if (docVerbs && /\b(ppt|pptx|power\s*point|powerpoint|slide\s*deck|presentation|deck|slides?)\b/i.test(t)) {
    kind = 'pptx';
  } else if (docVerbs && /\b(xlsx|excel|spread\s*sheet|spreadsheet|workbook|sheet)\b/i.test(t)) {
    kind = 'xlsx';
  } else if (docVerbs && /\b(docx|word\s*doc|word\s*document|report|essay|letter)\b/i.test(t)) {
    kind = 'docx';
  } else if (RESEARCH_VERB.test(t)
             || (/\b(research|look\s*up)\b/i.test(t) && /\b(on|about)\b/i.test(t))) {
    kind = 'research';
  }
  if (!kind) return null;

  // 1) details — "with/including …" (must run before audience: both can
  //    end at the end of the sentence).
  let rest = t;
  let details = '';
  const dm = /\s+(?:with|including|include|mention(?:ing)?|add(?:ing)?|cover(?:ing)?)\s*[:,-]?\s+(.+)$/i.exec(rest);
  if (dm && dm[1].trim().length > 2) {
    details = dm[1].trim().replace(/[.!?]+$/, '');
    rest = rest.slice(0, dm.index).trim();
  }

  // 2) audience — "for holiday homework", "for my class 10 project".
  const { audience, rest: afterAud } = splitAudience(rest);
  rest = afterAud;

  // 3) topic.
  let topic = kind === 'research'
    ? rest.replace(RESEARCH_VERB, '')
    : rest;
  topic = topic.replace(/\b(?:on|about|of|regarding|covering)\s+(.+)$/i, '$1');
  topic = topic.replace(/\b(please|a|an|the|new)\b/gi, ' ')
               .replace(DOC_WORDS, ' ')
               .replace(/\b(make|create|build|generate|prepare|write|draft|give|design|do|start)\b/gi, ' ')
               .replace(/\s+/g, ' ').trim();
  topic = topic.replace(/[.!?]+$/, '').trim();
  // "create a spreadsheet for my school project" → the "for" WAS the topic.
  if (!topic && audience) {
    topic = audience;
    return { kind, prefill: { topic, audience: '', details } };
  }
  return { kind, prefill: { topic: topic || 'Untitled', audience, details } };
}
