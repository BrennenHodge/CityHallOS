// Starting setup for a new city: departments, request types and assistant settings.
// Each city gets its own copy in its own data store, and staff change it from there.

export const DEFAULT_DEPARTMENTS = [
  { id: 'city-hall', name: 'City Hall' },
  { id: 'public-works', name: 'Public Works' },
  { id: 'water-sewer', name: 'Water & Sewer' },
  { id: 'planning-building', name: 'Planning & Building' },
  { id: 'sanitation', name: 'Sanitation' },
  { id: 'police', name: 'Police Department' },
];

export const DEFAULT_REQUEST_TYPES = [
  { key: 'pothole', label: 'Pothole or street damage', department_id: 'public-works' },
  { key: 'streetlight', label: 'Streetlight out', department_id: 'public-works' },
  { key: 'water', label: 'Water leak or no water', department_id: 'water-sewer', priority: 'high' },
  { key: 'sewer', label: 'Sewer backup or odor', department_id: 'water-sewer', priority: 'high' },
  { key: 'drainage', label: 'Drainage or flooding', department_id: 'public-works' },
  { key: 'trash', label: 'Missed garbage pickup', department_id: 'sanitation' },
  { key: 'debris', label: 'Tree or debris in road', department_id: 'public-works' },
  { key: 'sign', label: 'Damaged or missing street sign', department_id: 'public-works' },
  { key: 'animal', label: 'Stray or dead animal', department_id: 'police' },
  { key: 'code', label: 'Overgrown lot or code violation', department_id: 'planning-building' },
  { key: 'other', label: 'Something else', department_id: 'city-hall' },
];

export function defaultSettings({ name, shortName, prefix }) {
  return {
    shortName,
    assistantName: `Ask ${shortName}`,
    tagline: 'AI City Clerk · Answers from official city documents',
    greeting: `Welcome to City Hall OS for ${shortName}. I can help you find city information, understand permit procedures, locate forms and documents, and report issues to the right department. What can I help you with?`,
    brandColor: '#1f5c46',
    phone: '', address: '', hours: '', website: '', publicSite: '', policeNonEmergency: '', profileNotes: '',
    disambiguation: '',
    synonyms: {},
    requestPrefix: prefix || shortName.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase(),
    suggestions: [
      'How do I apply for a building permit?',
      'How do I pay my water bill?',
      'Where can I find the city ordinances?',
      'When is municipal court held?',
    ],
    cityName: name,
  };
}

export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
