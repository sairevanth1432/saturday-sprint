// University from the NIAT ID: in the 2026 university sheet every campus has its own ID prefix.
// Used when a sheet row or an admin-added student has no University, and to label older records that have none.
export const UNIVERSITY_PREFIXES = [
  ['N26AP01A', 'GMR Institute Of Technology - Vizianagaram'],
  ['N26B01A', 'S-VYASA University - Bengaluru'],
  ['N26B02A', 'Yenepoya University - Bangalore'],
  ['N26C01A', 'Crescent University - Chennai'],
  ['N26C02A', 'AMET University - Chennai'],
  ['N26C04A', "St.peter's Institute of Higher Education and Research -chennai"],
  ['N26H01A', 'Chaitanya – Deemed to be University - Hyderabad'],
  ['N26H02A', 'Malla Reddy University - Hyderabad'],
  ['N26H03A', 'Aurora Deemed University'],
  ['N26H04A', "St Mary's Rehabilitation University - Bhuvangiri"],
  ['N26HY01A', 'Sushant University - Gurugram'],
  ['N26HY02A', "Lingaya's Vidyapeeth - Faridabad"],
  ['N26HY03A', 'Geeta University - Panipat'],
  ['N26J01A', 'Vivekananda Global University - Jaipur'],
  ['N26K01A', 'Sanjay Ghodawat University - Kolhapur'],
  ['N26M01A', 'Yenepoya University - Mangalore'],
  ['N26MH01A', 'Sandip University - Nashik'],
  ['N26MP01A', 'Scope Global Skill University - Bhopal'],
  ['N26N01A', 'Noida International University- Noida'],
  ['N26O01A', 'Sri Sri University - Cuttack'],
  ['N26P01A', 'Ajeenkya DY Patil University - Pune'],
  ['N26P02A', 'ALARD - Pune'],
  ['N26R01A', 'Annamacharya University - Rajampet'],
  ['N26T01A', 'Takshashila University - Pondicherry'],
  ['N26U03A', 'Swami Vivekananda Subharti University'],
  ['N26V01A', 'NRI Institute of Technology - Vijayawada'],
  ['N26V02A', 'NSRIT - Vizag']
];

export const universityOf = (roll) => {
  const r = String(roll || '').toUpperCase();
  const hit = UNIVERSITY_PREFIXES.find(([p]) => r.startsWith(p));
  return hit ? hit[1] : '';
};

// One test student per university: NIAT ID TEST-<prefix>, name "Test <first word of the university>", batch TEST.
// They sit on their university's leaderboard (hidden on production, like every TEST account). Used by the test scripts.
export const TEST_UNIVERSITY_STUDENTS = UNIVERSITY_PREFIXES.map(([prefix, university]) => ({
  roll: 'TEST-' + prefix,
  name: 'Test ' + (university.split(/[^A-Za-z]+/).find((w) => w.length >= 3) || 'Student').replace(/^./, (c) => c.toUpperCase()),
  university
}));
