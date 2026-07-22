// cities.js - a curated "City, Country" list for the Location field's offline
// autocomplete (the app makes no network calls, so suggestions ship locally).
// This is a starting set of major/likely cities; the field still accepts any
// free text. Swap in a fuller dataset (via a main-process suggest IPC) later if
// exhaustive coverage is needed.

const CITIES = [
  // India
  "Mumbai, India", "Delhi, India", "Bengaluru, India", "Hyderabad, India", "Chennai, India",
  "Kolkata, India", "Pune, India", "Ahmedabad, India", "Jaipur, India", "Surat, India",
  "Lucknow, India", "Kanpur, India", "Nagpur, India", "Indore, India", "Bhopal, India",
  "Visakhapatnam, India", "Patna, India", "Vadodara, India", "Coimbatore, India", "Kochi, India",
  "Thiruvananthapuram, India", "Chandigarh, India", "Mysuru, India", "Gurugram, India", "Noida, India",
  "Madurai, India", "Nashik, India", "Vijayawada, India", "Guwahati, India", "Bhubaneswar, India",
  // United States
  "New York, United States", "Los Angeles, United States", "Chicago, United States", "Houston, United States",
  "Phoenix, United States", "Philadelphia, United States", "San Antonio, United States", "San Diego, United States",
  "Dallas, United States", "San Jose, United States", "Austin, United States", "Seattle, United States",
  "Denver, United States", "Boston, United States", "San Francisco, United States", "Washington, United States",
  "Atlanta, United States", "Miami, United States", "Portland, United States", "Las Vegas, United States",
  // Canada
  "Toronto, Canada", "Vancouver, Canada", "Montreal, Canada", "Calgary, Canada", "Ottawa, Canada", "Edmonton, Canada",
  // United Kingdom & Ireland
  "London, United Kingdom", "Manchester, United Kingdom", "Birmingham, United Kingdom", "Edinburgh, United Kingdom",
  "Glasgow, United Kingdom", "Bristol, United Kingdom", "Leeds, United Kingdom", "Cambridge, United Kingdom",
  "Oxford, United Kingdom", "Dublin, Ireland", "Cork, Ireland",
  // Europe
  "Paris, France", "Lyon, France", "Marseille, France", "Berlin, Germany", "Munich, Germany", "Frankfurt, Germany",
  "Hamburg, Germany", "Cologne, Germany", "Madrid, Spain", "Barcelona, Spain", "Valencia, Spain",
  "Rome, Italy", "Milan, Italy", "Naples, Italy", "Amsterdam, Netherlands", "Rotterdam, Netherlands",
  "Brussels, Belgium", "Zurich, Switzerland", "Geneva, Switzerland", "Vienna, Austria", "Lisbon, Portugal",
  "Porto, Portugal", "Stockholm, Sweden", "Oslo, Norway", "Copenhagen, Denmark", "Helsinki, Finland",
  "Warsaw, Poland", "Krakow, Poland", "Prague, Czechia", "Budapest, Hungary", "Athens, Greece",
  "Dublin, Ireland", "Moscow, Russia", "Saint Petersburg, Russia", "Kyiv, Ukraine", "Istanbul, Turkey", "Ankara, Turkey",
  // Middle East
  "Dubai, United Arab Emirates", "Abu Dhabi, United Arab Emirates", "Doha, Qatar", "Riyadh, Saudi Arabia",
  "Jeddah, Saudi Arabia", "Kuwait City, Kuwait", "Manama, Bahrain", "Muscat, Oman",
  "Tel Aviv, Israel", "Jerusalem, Israel", "Amman, Jordan", "Beirut, Lebanon", "Cairo, Egypt",
  // Asia-Pacific
  "Singapore, Singapore", "Hong Kong, China", "Beijing, China", "Shanghai, China", "Shenzhen, China",
  "Guangzhou, China", "Tokyo, Japan", "Osaka, Japan", "Kyoto, Japan", "Yokohama, Japan",
  "Seoul, South Korea", "Busan, South Korea", "Taipei, Taiwan", "Bangkok, Thailand", "Kuala Lumpur, Malaysia",
  "Jakarta, Indonesia", "Manila, Philippines", "Ho Chi Minh City, Vietnam", "Hanoi, Vietnam",
  "Colombo, Sri Lanka", "Dhaka, Bangladesh", "Karachi, Pakistan", "Lahore, Pakistan", "Islamabad, Pakistan",
  "Kathmandu, Nepal",
  // Australia & New Zealand
  "Sydney, Australia", "Melbourne, Australia", "Brisbane, Australia", "Perth, Australia", "Adelaide, Australia",
  "Canberra, Australia", "Auckland, New Zealand", "Wellington, New Zealand",
  // Africa
  "Lagos, Nigeria", "Abuja, Nigeria", "Nairobi, Kenya", "Johannesburg, South Africa", "Cape Town, South Africa",
  "Accra, Ghana", "Addis Ababa, Ethiopia", "Casablanca, Morocco", "Dar es Salaam, Tanzania",
  // Latin America
  "Mexico City, Mexico", "Guadalajara, Mexico", "Sao Paulo, Brazil", "Rio de Janeiro, Brazil", "Brasilia, Brazil",
  "Buenos Aires, Argentina", "Santiago, Chile", "Lima, Peru", "Bogota, Colombia", "Medellin, Colombia",
  "Panama City, Panama", "San Jose, Costa Rica",
];

// Approximate [lat, lon] for each city above, for the offline Geomap. Keyed by
// the exact "City, Country" string so lookups match stored location values.
const CITY_COORDS = {
  "Mumbai, India": [19.08, 72.88], "Delhi, India": [28.61, 77.21], "Bengaluru, India": [12.97, 77.59],
  "Hyderabad, India": [17.38, 78.49], "Chennai, India": [13.08, 80.27], "Kolkata, India": [22.57, 88.36],
  "Pune, India": [18.52, 73.86], "Ahmedabad, India": [23.03, 72.58], "Jaipur, India": [26.91, 75.79],
  "Surat, India": [21.17, 72.83], "Lucknow, India": [26.85, 80.95], "Kanpur, India": [26.45, 80.33],
  "Nagpur, India": [21.15, 79.09], "Indore, India": [22.72, 75.86], "Bhopal, India": [23.26, 77.41],
  "Visakhapatnam, India": [17.69, 83.22], "Patna, India": [25.59, 85.14], "Vadodara, India": [22.31, 73.18],
  "Coimbatore, India": [11.02, 76.96], "Kochi, India": [9.93, 76.27], "Thiruvananthapuram, India": [8.52, 76.94],
  "Chandigarh, India": [30.73, 76.78], "Mysuru, India": [12.30, 76.64], "Gurugram, India": [28.46, 77.03],
  "Noida, India": [28.54, 77.39], "Madurai, India": [9.93, 78.12], "Nashik, India": [19.997, 73.79],
  "Vijayawada, India": [16.51, 80.65], "Guwahati, India": [26.14, 91.74], "Bhubaneswar, India": [20.30, 85.82],
  "New York, United States": [40.71, -74.01], "Los Angeles, United States": [34.05, -118.24],
  "Chicago, United States": [41.88, -87.63], "Houston, United States": [29.76, -95.37],
  "Phoenix, United States": [33.45, -112.07], "Philadelphia, United States": [39.95, -75.17],
  "San Antonio, United States": [29.42, -98.49], "San Diego, United States": [32.72, -117.16],
  "Dallas, United States": [32.78, -96.80], "San Jose, United States": [37.34, -121.89],
  "Austin, United States": [30.27, -97.74], "Seattle, United States": [47.61, -122.33],
  "Denver, United States": [39.74, -104.99], "Boston, United States": [42.36, -71.06],
  "San Francisco, United States": [37.77, -122.42], "Washington, United States": [38.90, -77.04],
  "Atlanta, United States": [33.75, -84.39], "Miami, United States": [25.76, -80.19],
  "Portland, United States": [45.51, -122.68], "Las Vegas, United States": [36.17, -115.14],
  "Toronto, Canada": [43.65, -79.38], "Vancouver, Canada": [49.28, -123.12], "Montreal, Canada": [45.50, -73.57],
  "Calgary, Canada": [51.05, -114.07], "Ottawa, Canada": [45.42, -75.70], "Edmonton, Canada": [53.55, -113.49],
  "London, United Kingdom": [51.51, -0.13], "Manchester, United Kingdom": [53.48, -2.24],
  "Birmingham, United Kingdom": [52.49, -1.89], "Edinburgh, United Kingdom": [55.95, -3.19],
  "Glasgow, United Kingdom": [55.86, -4.25], "Bristol, United Kingdom": [51.45, -2.59],
  "Leeds, United Kingdom": [53.80, -1.55], "Cambridge, United Kingdom": [52.20, 0.12],
  "Oxford, United Kingdom": [51.75, -1.26], "Dublin, Ireland": [53.35, -6.26], "Cork, Ireland": [51.90, -8.47],
  "Paris, France": [48.85, 2.35], "Lyon, France": [45.76, 4.84], "Marseille, France": [43.30, 5.37],
  "Berlin, Germany": [52.52, 13.40], "Munich, Germany": [48.14, 11.58], "Frankfurt, Germany": [50.11, 8.68],
  "Hamburg, Germany": [53.55, 9.99], "Cologne, Germany": [50.94, 6.96], "Madrid, Spain": [40.42, -3.70],
  "Barcelona, Spain": [41.39, 2.17], "Valencia, Spain": [39.47, -0.38], "Rome, Italy": [41.90, 12.50],
  "Milan, Italy": [45.46, 9.19], "Naples, Italy": [40.85, 14.27], "Amsterdam, Netherlands": [52.37, 4.90],
  "Rotterdam, Netherlands": [51.92, 4.48], "Brussels, Belgium": [50.85, 4.35], "Zurich, Switzerland": [47.37, 8.54],
  "Geneva, Switzerland": [46.20, 6.14], "Vienna, Austria": [48.21, 16.37], "Lisbon, Portugal": [38.72, -9.14],
  "Porto, Portugal": [41.15, -8.61], "Stockholm, Sweden": [59.33, 18.06], "Oslo, Norway": [59.91, 10.75],
  "Copenhagen, Denmark": [55.68, 12.57], "Helsinki, Finland": [60.17, 24.94], "Warsaw, Poland": [52.23, 21.01],
  "Krakow, Poland": [50.06, 19.94], "Prague, Czechia": [50.08, 14.44], "Budapest, Hungary": [47.50, 19.04],
  "Athens, Greece": [37.98, 23.73], "Moscow, Russia": [55.76, 37.62], "Saint Petersburg, Russia": [59.93, 30.34],
  "Kyiv, Ukraine": [50.45, 30.52], "Istanbul, Turkey": [41.01, 28.98], "Ankara, Turkey": [39.93, 32.86],
  "Dubai, United Arab Emirates": [25.20, 55.27], "Abu Dhabi, United Arab Emirates": [24.45, 54.38],
  "Doha, Qatar": [25.29, 51.53], "Riyadh, Saudi Arabia": [24.71, 46.68], "Jeddah, Saudi Arabia": [21.49, 39.19],
  "Kuwait City, Kuwait": [29.38, 47.99], "Manama, Bahrain": [26.23, 50.59], "Muscat, Oman": [23.59, 58.41],
  "Tel Aviv, Israel": [32.09, 34.78], "Jerusalem, Israel": [31.77, 35.21], "Amman, Jordan": [31.95, 35.93],
  "Beirut, Lebanon": [33.89, 35.50], "Cairo, Egypt": [30.04, 31.24],
  "Singapore, Singapore": [1.35, 103.82], "Hong Kong, China": [22.32, 114.17], "Beijing, China": [39.90, 116.41],
  "Shanghai, China": [31.23, 121.47], "Shenzhen, China": [22.54, 114.06], "Guangzhou, China": [23.13, 113.26],
  "Tokyo, Japan": [35.68, 139.69], "Osaka, Japan": [34.69, 135.50], "Kyoto, Japan": [35.01, 135.77],
  "Yokohama, Japan": [35.44, 139.64], "Seoul, South Korea": [37.57, 126.98], "Busan, South Korea": [35.18, 129.08],
  "Taipei, Taiwan": [25.03, 121.57], "Bangkok, Thailand": [13.76, 100.50], "Kuala Lumpur, Malaysia": [3.14, 101.69],
  "Jakarta, Indonesia": [-6.21, 106.85], "Manila, Philippines": [14.60, 120.98],
  "Ho Chi Minh City, Vietnam": [10.82, 106.63], "Hanoi, Vietnam": [21.03, 105.85], "Colombo, Sri Lanka": [6.93, 79.85],
  "Dhaka, Bangladesh": [23.81, 90.41], "Karachi, Pakistan": [24.86, 67.01], "Lahore, Pakistan": [31.55, 74.34],
  "Islamabad, Pakistan": [33.68, 73.05], "Kathmandu, Nepal": [27.72, 85.32],
  "Sydney, Australia": [-33.87, 151.21], "Melbourne, Australia": [-37.81, 144.96], "Brisbane, Australia": [-27.47, 153.03],
  "Perth, Australia": [-31.95, 115.86], "Adelaide, Australia": [-34.93, 138.60], "Canberra, Australia": [-35.28, 149.13],
  "Auckland, New Zealand": [-36.85, 174.76], "Wellington, New Zealand": [-41.29, 174.78],
  "Lagos, Nigeria": [6.52, 3.38], "Abuja, Nigeria": [9.06, 7.50], "Nairobi, Kenya": [-1.29, 36.82],
  "Johannesburg, South Africa": [-26.20, 28.05], "Cape Town, South Africa": [-33.92, 18.42],
  "Accra, Ghana": [5.60, -0.19], "Addis Ababa, Ethiopia": [9.03, 38.74], "Casablanca, Morocco": [33.57, -7.59],
  "Dar es Salaam, Tanzania": [-6.79, 39.21],
  "Mexico City, Mexico": [19.43, -99.13], "Guadalajara, Mexico": [20.66, -103.35], "Sao Paulo, Brazil": [-23.55, -46.63],
  "Rio de Janeiro, Brazil": [-22.91, -43.17], "Brasilia, Brazil": [-15.79, -47.88], "Buenos Aires, Argentina": [-34.60, -58.38],
  "Santiago, Chile": [-33.45, -70.67], "Lima, Peru": [-12.05, -77.04], "Bogota, Colombia": [4.71, -74.07],
  "Medellin, Colombia": [6.24, -75.58], "Panama City, Panama": [8.98, -79.52], "San Jose, Costa Rica": [9.93, -84.08],
};

module.exports = { CITIES, CITY_COORDS };
