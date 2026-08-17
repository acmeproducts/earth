export const EXAMPLE_LOCATIONS = [
  {
    name: "Reso",
    lat: 58.79605454187253,
    lon: 11.182361556113896,
  },
  {
    name: "Storyodden",
    lat: 59.8888085995981,
    lon: 10.593090176648504,
  },
  {
    name: "Casa",
    lat: 59.904706664625266,
    lon: 10.61104958556299,
  },
  {
    name: "Fornebu",
    lat: 59.8833298,
    lon: 10.6166642,
  },
  {
    name: "Valserud",
    lat: 59.58990531228428,
    lon: 13.783101006047959,
  },
  {
    name: "Gaustatoppen",
    lat: 59.85373224178274,
    lon: 8.649698171043344,
  },
  {
    name: "New York",
    lat: 40.70562745934957,
    lon: -74.01329094009722,
  },
  {
    name: "Edsåsdalen",
    lat: 63.31740743074281,
    lon: 13.074744350282623,
  },
  {
    name: "Bangladesh",
    lat: 22.046490468966393,
    lon: 90.67841786422733,
  },
] as const;

export type ExampleLocation = (typeof EXAMPLE_LOCATIONS)[number];
