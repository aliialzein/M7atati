import ground from "../../assets/canopy-ground.svg";
import roofTop from "../../assets/canopy-roof-top.svg";
import roofBottom from "../../assets/canopy-roof-bottom.svg";
import pole from "../../assets/canopy-pole.svg";
import pumpBody from "../../assets/canopy-pump-body.svg";
import pumpLine from "../../assets/canopy-pump-line.svg";
import pumpHose from "../../assets/canopy-pump-hose.svg";
import starA from "../../assets/canopy-star-a.svg";
import starB from "../../assets/canopy-star-b.svg";
import starC from "../../assets/canopy-star-c.svg";

// [src, outer inset (top right bottom left), inner overflow inset (optional)]
const PIECES = [
  [ground, "91.11% 2.94% 8.89% 2.94%", "-0.63px -0.2%"],
  [roofTop, "35.56% 11.18% 55.56% 14.12%", "-7.81% -0.25%"],
  [roofBottom, "44.44% 11.18% 51.11% 14.12%", "-15.63% -0.25% -15.62% -0.25%"],
  [pole, "48.89% 74.12% 8.89% 25.88%", "-1.64% -0.63px"],
  [pole, "48.89% 72.94% 8.89% 27.06%", "-1.64% -0.63px"],
  [pole, "48.89% 24.12% 8.89% 75.88%", "-1.64% -0.63px"],
  [pole, "48.89% 22.94% 8.89% 77.06%", "-1.64% -0.63px"],
  [pumpBody, "64.44% 58.24% 8.89% 35.29%", "-2.6% -2.84%"],
  [pumpLine, "71.11% 59.71% 28.89% 36.76%", "-0.63px -5.21%"],
  [pumpHose, "73.33% 57.35% 14.5% 41.76%", "-5.71% -20.83%"],
  [pumpBody, "64.44% 32.35% 8.89% 61.18%", "-2.6% -2.84%"],
  [pumpLine, "71.11% 33.82% 28.89% 62.65%", "-0.63px -5.21%"],
  [pumpHose, "73.33% 31.47% 14.5% 67.65%", "-5.71% -20.83%"],
  [starA, "19.17% 15.96% 79.17% 83.6%"],
  [starB, "12.5% 32.13% 85.83% 67.43%"],
  [starB, "16.94% 71.84% 81.39% 27.72%"],
  [starC, "15.56% 47.5% 76.67% 50.44%"],
];

export default function Canopy() {
  return (
    <div className="canopy" aria-hidden="true">
      {PIECES.map(([src, inset, inner], i) => (
        <div key={i} className="canopy__piece" style={{ inset }}>
          {inner ? (
            <div className="canopy__inner" style={{ inset: inner }}>
              <img src={src} alt="" />
            </div>
          ) : (
            <img className="canopy__fill" src={src} alt="" />
          )}
        </div>
      ))}
    </div>
  );
}
