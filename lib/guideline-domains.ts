// lib/guideline-domains.ts
// Central registry of all UK and European clinical guideline domains.
// Used by the AI provider to restrict web searches to trusted sources.
// Add new domains here — they'll automatically be picked up by the triage system.

export interface GuidelineDomain {
  domain: string
  name: string
  specialty: string
}

export const GUIDELINE_DOMAINS: GuidelineDomain[] = [
  // ── Core UK national guidance ──
  { domain: 'cks.nice.org.uk', name: 'NICE CKS', specialty: 'Primary care (all)' },
  { domain: 'nice.org.uk', name: 'NICE Guidelines', specialty: 'All specialties' },
  { domain: 'bnf.nice.org.uk', name: 'BNF / BNFC', specialty: 'Prescribing' },
  { domain: 'sign.ac.uk', name: 'SIGN Guidelines', specialty: 'Scotland (all)' },
  { domain: 'rcgp.org.uk', name: 'RCGP', specialty: 'General practice' },

  // ── Prescribing, safety & public health ──
  { domain: 'sps.nhs.uk', name: 'Specialist Pharmacy Service', specialty: 'Prescribing' },
  { domain: 'medicines.org.uk', name: 'eMC (SmPCs)', specialty: 'Drug information' },
  { domain: 'gov.uk', name: 'MHRA / Green Book / PHE', specialty: 'Safety & immunisation' },

  // ── Dermatology ──
  { domain: 'bad.org.uk', name: 'British Association of Dermatologists', specialty: 'Dermatology' },
  { domain: 'pcds.org.uk', name: 'Primary Care Dermatology Society', specialty: 'Dermatology' },

  // ── Respiratory ──
  { domain: 'brit-thoracic.org.uk', name: 'British Thoracic Society', specialty: 'Respiratory' },
  { domain: 'asthma.org.uk', name: 'Asthma + Lung UK', specialty: 'Respiratory' },

  // ── Cardiology ──
  { domain: 'escardio.org', name: 'European Society of Cardiology', specialty: 'Cardiology' },
  { domain: 'bhf.org.uk', name: 'British Heart Foundation', specialty: 'Cardiology' },
  { domain: 'bcs.com', name: 'British Cardiovascular Society', specialty: 'Cardiology' },

  // ── Women's health & O&G ──
  { domain: 'rcog.org.uk', name: 'Royal College of Obstetricians & Gynaecologists', specialty: 'O&G' },
  { domain: 'thebms.org.uk', name: 'British Menopause Society', specialty: 'Menopause / HRT' },
  { domain: 'fsrh.org', name: 'Faculty of Sexual & Reproductive Healthcare', specialty: 'Contraception' },

  // ── Gastroenterology ──
  { domain: 'bsg.org.uk', name: 'British Society of Gastroenterology', specialty: 'Gastroenterology' },

  // ── Rheumatology & MSK ──
  { domain: 'rheumatology.org.uk', name: 'British Society for Rheumatology', specialty: 'Rheumatology' },
  { domain: 'nogg.org.uk', name: 'National Osteoporosis Guideline Group', specialty: 'Osteoporosis' },

  // ── Endocrine & diabetes ──
  { domain: 'british-thyroid-association.org', name: 'British Thyroid Association', specialty: 'Thyroid' },
  { domain: 'diabetes.org.uk', name: 'Diabetes UK', specialty: 'Diabetes' },
  { domain: 'abcd.care', name: 'Association of British Clinical Diabetologists', specialty: 'Diabetes' },

  // ── Mental health ──
  { domain: 'rcpsych.ac.uk', name: 'Royal College of Psychiatrists', specialty: 'Psychiatry' },
  { domain: 'bap.org.uk', name: 'British Association for Psychopharmacology', specialty: 'Psychopharmacology' },

  // ── ENT ──
  { domain: 'entuk.org', name: 'ENT UK', specialty: 'ENT' },

  // ── Ophthalmology ──
  { domain: 'rcophth.ac.uk', name: 'Royal College of Ophthalmologists', specialty: 'Ophthalmology' },

  // ── Urology ──
  { domain: 'baus.org.uk', name: 'British Association of Urological Surgeons', specialty: 'Urology' },
  { domain: 'uroweb.org', name: 'European Association of Urology', specialty: 'Urology' },

  // ── Sexual health ──
  { domain: 'bashh.org', name: 'BASHH', specialty: 'Sexual health / GUM' },

  // ── Neurology ──
  { domain: 'epilepsysociety.org.uk', name: 'Epilepsy Society', specialty: 'Neurology' },
  { domain: 'migrainetrust.org', name: 'Migraine Trust', specialty: 'Neurology' },

  // ── Paediatrics ──
  { domain: 'rcpch.ac.uk', name: 'Royal College of Paediatrics', specialty: 'Paediatrics' },

  // ── Haematology ──
  { domain: 'b-s-h.org.uk', name: 'British Society for Haematology', specialty: 'Haematology' },

  // ── Renal ──
  { domain: 'renal.org', name: 'UK Kidney Association', specialty: 'Renal' },

  // ── Palliative care ──
  { domain: 'palliativecareguidelines.scot.nhs.uk', name: 'Scottish Palliative Care Guidelines', specialty: 'Palliative care' },

  // ── European (UK-relevant) ──
  { domain: 'eular.org', name: 'EULAR', specialty: 'Rheumatology (European)' },
  { domain: 'esmo.org', name: 'ESMO', specialty: 'Oncology (European)' },
  { domain: 'ers.app', name: 'European Respiratory Society', specialty: 'Respiratory (European)' },
  { domain: 'easd.org', name: 'European Association for Study of Diabetes', specialty: 'Diabetes (European)' },
  { domain: 'euronheart.org', name: 'EuroNHeart', specialty: 'Cardiology (European)' },
]

// Helper: get just the domain strings (for allowed_domains in AI provider)
export function getAllGuidelineDomainStrings(): string[] {
  return GUIDELINE_DOMAINS.map(d => d.domain)
}

// Helper: get domains for a specific specialty
export function getDomainsBySpecialty(specialty: string): GuidelineDomain[] {
  const lower = specialty.toLowerCase()
  return GUIDELINE_DOMAINS.filter(d =>
    d.specialty.toLowerCase().includes(lower)
  )
}

// Helper: look up a domain name from a URL
export function getGuidelineSourceName(url: string): string | null {
  for (const d of GUIDELINE_DOMAINS) {
    if (url.includes(d.domain)) return d.name
  }
  return null
}
