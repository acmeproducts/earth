export const EXAMPLE_LOCATIONS = [
  {
    name: "Swedish west coast",
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
] as const;

export type ExampleLocation = (typeof EXAMPLE_LOCATIONS)[number];
