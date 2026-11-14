#!/usr/bin/env node
/**
 * Judges a capture_report.json written by scripts/capture_custom_milk_screenshots.mjs.
 *
 * The nightly screenshot job runs the capture with continue-on-error so that one bad preset does not
 * stop the report from being uploaded. That alone made the job green whatever happened (17 of 35
 * presets were failing and nobody saw it). This script is the step after the upload that says what
 * happened, in the run summary, and fails the job when it should:
 *
 *   - the report is missing or has no results (the capture did not get as far as writing it),
 *   - a preset failed that is not listed in the known-failures ledger, or
 *   - a preset listed in the ledger now captures fine (the ledger only shrinks: delete its line).
 *
 * Usage:
 *   node scripts/check_capture_report.mjs <capture_report.json> <known_capture_failures.txt>
 *
 * Writes a Markdown table to $GITHUB_STEP_SUMMARY when it is set. Exit 0 = nothing new, 1 = fail.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [reportPath, ledgerPath] = process.argv.slice(2);
if (!reportPath || !ledgerPath) {
    console.error('usage: node scripts/check_capture_report.mjs <capture_report.json> <known_capture_failures.txt>');
    process.exit(2);
}

/** @param {string[]} lines */
function summary(lines) {
    const text = lines.join('\n') + '\n';
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

if (!existsSync(reportPath)) {
    summary(['## Preset capture', '', `**No report at \`${reportPath}\`.** The capture did not finish; see the capture step's log.`]);
    process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const results = Array.isArray(report.results) ? report.results : [];
if (results.length === 0) {
    summary(['## Preset capture', '', 'The report has no results.']);
    process.exit(1);
}

const known = new Set(
    readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean),
);

const failed = results.filter((entry) => !entry.ok);
const failedNames = new Set(failed.map((entry) => entry.preset));
const unexpected = failed.filter((entry) => !known.has(entry.preset));
const nowPassing = [...known].filter((name) => results.some((entry) => entry.preset === name) && !failedNames.has(name));
const notRun = [...known].filter((name) => !results.some((entry) => entry.preset === name));

const firstLine = (entry) => String(entry.error ?? '').split('\n')[0].replace(/\|/g, '\\|').slice(0, 160);
const lines = [
    '## Preset capture',
    '',
    `${results.length - failed.length} of ${results.length} captured; ${failed.length} failed (${failed.length - unexpected.length} known, ${unexpected.length} new).`,
];
if (unexpected.length > 0) {
    lines.push('', '### New failures', '', '| preset | error |', '|---|---|', ...unexpected.map((entry) => `| ${entry.preset} | ${firstLine(entry)} |`));
}
if (nowPassing.length > 0) {
    lines.push('', '### Listed as known-bad but captured fine: delete from `tests/wasm-smoke/known_capture_failures.txt`', '', ...nowPassing.map((name) => `- ${name}`));
}
if (notRun.length > 0) {
    lines.push('', '### Listed as known-bad but not in the report (preset renamed or removed?)', '', ...notRun.map((name) => `- ${name}`));
}
summary(lines);

process.exit(unexpected.length > 0 || nowPassing.length > 0 || notRun.length > 0 ? 1 : 0);
