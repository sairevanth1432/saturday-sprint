// University from the NIAT ID: in the 2026 university sheet every campus has its own ID prefix.
// Used when a sheet row or an admin-added student has no University, and to label older records that have none.
export const UNIVERSITY_PREFIXES = [
  ['N26H01A', 'Chaitanya – Deemed to be University - Hyderabad'],
  ['N26P02A', 'ALARD - Pune'],
  ['N26C04A', "St.peter's Institute of Higher Education and Research -chennai"],
  ['N26HY01A', 'Sushant University - Gurugram'],
  ['N26HY03A', 'Geeta University - Panipat']
];

export const universityOf = (roll) => {
  const r = String(roll || '').toUpperCase();
  const hit = UNIVERSITY_PREFIXES.find(([p]) => r.startsWith(p));
  return hit ? hit[1] : '';
};
