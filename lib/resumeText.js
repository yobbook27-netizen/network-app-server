function splitCsv(input) {
  return (input || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/*
  ── FOUR SECTIONS USED TO ARRIVE HERE AND GO IN THE BIN — SESSION 61 ─────────────────────────

  ResumeScreen.tsx:187 says: "Every field here is sent verbatim to critiqueResume() and
  compareResumeToJd() … so new sections are included in the AI critique and JD comparison
  without any change at the call site."

  The first half was true and the second half was false. Session 38 grew the resume by four
  sections — languages, publications, references, and a free-text "other" — the app posted all
  four over the network, and this function read eleven of the fifteen fields and never looked at
  those. They were discarded before the prompt was built.

  MEASURED, twice. Session 60 sent a critique payload carrying Spanish, a named referee and an
  Eagle Scout line; the critique mentioned none of them and then recommended cutting Interests
  "to reclaim space". Session 61 sent one carrying a co-authored paper in the BU Undergraduate
  Economics Review, two languages, a referee and a portfolio link; the critique mentioned none
  of those either, and again proposed cutting Interests for room. A student who fills in
  Publications and gets feedback that ignores them has been told their work does not matter.

  The contract now holds in the direction the comment claims: what the app sends is what the
  model reads. The alternative was to stop sending four fields the user had filled in, which is
  the same defect with the evidence removed.
*/

/** One rendered line per repeatable entry, skipping the entries the user left blank. */
function entryLines(entries, render) {
  return (entries || []).filter((e) => e && (e.title || e.org || e.desc)).map(render);
}

export function buildResumeText(fields) {
  const certifications = splitCsv(fields.certInput);
  const skills = splitCsv(fields.skillsInput);
  const languages = splitCsv(fields.languagesInput);

  const lines = [];
  lines.push(fields.fullName || "Name not entered");
  if (fields.summary) lines.push(`Summary: ${fields.summary}`);
  lines.push(`Education: ${fields.educationLine}`);
  if (fields.gpa) lines.push(`GPA: ${fields.gpa}`);
  if (fields.honors) lines.push(`Honors: ${fields.honors}`);
  if (fields.coursework) lines.push(`Relevant coursework: ${fields.coursework}`);
  lines.push("Experience:");
  (fields.experience || []).forEach((e) => {
    lines.push(`- ${e.title} at ${e.org} (${e.dates}): ${e.desc}`);
  });
  if ((fields.activities || []).some((a) => a.title || a.desc)) {
    lines.push("Leadership & Activities:");
    fields.activities.forEach((a) => {
      lines.push(`- ${a.title} at ${a.org} (${a.dates}): ${a.desc}`);
    });
  }
  if (certifications.length > 0) lines.push(`Certifications: ${certifications.join(", ")}`);
  if (skills.length > 0) lines.push(`Skills: ${skills.join(", ")}`);
  if (languages.length > 0) lines.push(`Languages: ${languages.join(", ")}`);

  // publications: title / publisher-or-journal / date / notes — see ResumeFields in
  // src/types/index.ts, which is where the four slots on each entry get their meaning.
  const publications = entryLines(
    fields.publications,
    (p) => `- ${p.title}${p.org ? `, ${p.org}` : ""}${p.dates ? ` (${p.dates})` : ""}${p.desc ? `: ${p.desc}` : ""}`
  );
  if (publications.length > 0) lines.push("Publications:", ...publications);

  // references: name / title & organization / relationship / contact details. The contact
  // details slot is deliberately NOT rendered — a referee's email is the one field on this
  // resume that belongs to somebody who is not the user, and no critique needs it to do its
  // job.
  const references = entryLines(
    fields.references,
    (r) => `- ${r.title}${r.org ? `, ${r.org}` : ""}${r.dates ? ` (${r.dates})` : ""}`
  );
  if (references.length > 0) lines.push("References:", ...references);

  if (fields.interests) lines.push(`Interests: ${fields.interests}`);
  if (fields.other) lines.push(`Other: ${fields.other}`);
  return lines.join("\n");
}
