/**
 * R12: ordinary words of a spoken question that are never "a stored attribute the organization lacks": units, politeness, asking verbs, format words.
 * The records lane builds a decline ("I don't have X on file") or a "none of the stored fields is about X" only from words that could be a stored thing;
 * a glue word, or a typo of one, is just part of the sentence. Pure, no I/O.
 */
import { withinOne } from "../lookups/nameMatch.js";

const GLUE = new Set(("dollar dollars buck bucks cent cents usd money amount amounts sum sums number numbers digit digits figure figures count counts day days hour hours minute minutes week weeks month months year years date dates time times "
  + "random basic basics quick quickly simple simply real really just kind sort sorts type types thing things stuff books book boss thx thanks thank please plz pls asap sure okay "
  + "located locate location find found finding look looking lookup pull pulled show showed showing tell told give gave get got getting see seen check checked need needed want wanted trying tried handle handled "
  + "tied linked related attached connected associated assigned marked listed written stored recorded printed saved filed held containing contains contain contained include includes included including "
  + "during within since before after between until through throughout around about over under during ago recent recently lately current currently ever always never still already yet again once twice "
  + "word words name names text note notes info information detail details record records file files entry entries item items one ones some any every each both either other another others same different "
  + "whole entire total totals overall full partial rest remaining left first last second third fourth fifth latest newest oldest earliest final next previous prior "
  + "back ahead away off onto upon into where whats what whos who whom whose when which while whether why how there here this that these those them they their then than because since also too very much many more most less least few "
  + "have has had having does did done doing made make making work works worked working put puts took take taken taking came come went going gone been being were was").split(/\s+/));

const LONG = [...GLUE].filter((w) => w.length >= 5);

export function isGlueWord(w) {
  const t = String(w ?? "").toLowerCase();
  if (GLUE.has(t)) return true;
  if (t.length >= 5 && LONG.some((g) => withinOne(t, g))) return true; // a one-letter slip of a glue word ("whre" is too short and is listed below)
  return t === "whre" || t === "wher" || t === "wat" || t === "wht";
}

/** shape words: the question asks for a list, a count, an order, a share or a period. The lane that cannot read that shape must not answer or decline it as "not on file". */
export const SHAPE_RE = /\b(?:lists?|which|how many|how much|rundown|run down|every|each|all|share|percent|percentage|average|avg|total|sum|count|number of|numbers|between|since|before|after|during|within|last|latest|first|oldest|newest|most recent|recent|earliest|top|per|compare|versus|vs|biggest|largest|smallest|highest|lowest|ranking|rank|how long|how often|days? (?:since|from|between)|second|third|fourth|fifth)\b/;

const NOISE = new Set("thx thanks thank please plz pls plase pleas asap boss books book quick quickly basic random sure okay hey hello donovan buddy".split(/\s+/));
/** politeness / spoken noise and its one-letter typos ("boos", "qick", "plaese" is too far): never a condition of the question */
export function isNoiseWord(w) {
  const t = String(w ?? "").toLowerCase();
  if (NOISE.has(t)) return true;
  return t.length >= 4 && [...NOISE].some((n) => n.length >= 4 && withinOne(t, n));
}

/** aggregate / comparison shapes (a count, a share, a total, a comparison, a ranking): a dump of one customer's file never answers these */
export const AGG_RE = /\b(?:how many|how much|share|percent|percentage|average|avg|total|sum|count|number of|compare|versus|vs|biggest|largest|smallest|highest|lowest|ranking|rank|how long|how often|than)\b/;
