// Defaults for each city on the platform. Staff can override most of these in Settings.

export const DEFAULT_SETTINGS = {
  wiggins: {
    cityName: 'City of Wiggins',
    state: 'Mississippi',
    county: 'Stone County',
    assistantName: 'Ask Wiggins',
    tagline: 'AI City Clerk · Answers from official city documents',
    greeting: "Welcome to City Hall OS for Wiggins, Mississippi. I can help you find city information, understand permit procedures, locate forms and documents, and report issues to the right department. What can I help you with?",
    brandColor: '#1f5c46',
    phone: '601-928-7221',
    address: '117 First Street North, Wiggins, MS 39577',
    hours: '',
    website: 'https://www.cityofwiggins.gov',
    policeNonEmergency: '601-928-5444',
    profileNotes: '',
    requestPrefix: 'WIG',
    suggestions: [
      'How do I apply for a building permit?',
      'How do I pay my water bill?',
      'Where can I find the city ordinances?',
      'When is municipal court held?',
    ],
    // Fictional staff used for assignment until the city's own users are set up.
    staff: [
      { name: 'Jordan Reed', role: 'City Clerk office', department: 'City Hall' },
      { name: 'Marcus Hill', role: 'Street crew lead', department: 'Public Works' },
      { name: 'Dana Whitfield', role: 'Utility technician', department: 'Water & Sewer' },
      { name: 'Chris Nolan', role: 'Permit technician', department: 'Planning & Building' },
      { name: 'Taylor Brooks', role: 'Sanitation coordinator', department: 'Sanitation' },
      { name: 'Sam Ortiz', role: 'Animal control officer', department: 'Police Department' },
    ],
  },
};

export const REQUEST_TYPES = [
  { key: 'pothole', label: 'Pothole or street damage', department: 'Public Works' },
  { key: 'streetlight', label: 'Streetlight out', department: 'Public Works' },
  { key: 'water', label: 'Water leak or no water', department: 'Water & Sewer', priority: 'high' },
  { key: 'sewer', label: 'Sewer backup or odor', department: 'Water & Sewer', priority: 'high' },
  { key: 'drainage', label: 'Drainage or flooding', department: 'Public Works' },
  { key: 'trash', label: 'Missed garbage pickup', department: 'Sanitation' },
  { key: 'debris', label: 'Tree or debris in road', department: 'Public Works' },
  { key: 'sign', label: 'Damaged or missing street sign', department: 'Public Works' },
  { key: 'animal', label: 'Stray or dead animal', department: 'Police Department' },
  { key: 'code', label: 'Overgrown lot or code violation', department: 'Planning & Building' },
  { key: 'other', label: 'Something else', department: 'City Hall' },
];
