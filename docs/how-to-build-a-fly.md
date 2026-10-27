# Build a fly that learns to fly

This builds, from an empty 3D project, the same fly as the **Fly** template. Allow 10 minutes, plus about 1 minute of training.

The idea: a fly is a light body with four wings. Each wing pushes upward (a *thruster*). The brain controls how hard each wing pushes, so it has to learn to balance all four, tilt to move, and slow down at the flower.

## 1. Start a 3D project
1. Logo menu → **New from template…** → **Blank 3D**.
2. In **World**, select the capsule agent's spawn in the Outliner (you will replace the agent in step 2).

## 2. Make the fly's body (Entity workspace)
1. Go to **Entity**. Click **Body · rigid** in the component stack. In Properties set:
   - Shape **box**, Size **0.5 · 0.14 · 0.5**, Mass **0.3**
   - Linear damping **0.4**, Angular damping **1.5**
   - **Upright: off** (it must be able to tilt; tilting is how it steers)
2. Remove the **move** actuator (right-click → Remove). Flies don't walk.
3. **Add component → Actuators · thrusters**. Add 4 thrusters (wings):

   | name | pos (x, y, z) | dir | max force |
   |---|---|---|---|
   | frontLeft | 0.22, 0, −0.22 | 0, 1, 0 | 1.47 |
   | frontRight | 0.22, 0, 0.22 | 0, 1, 0 | 1.47 |
   | backLeft | −0.22, 0, −0.22 | 0, 1, 0 | 1.47 |
   | backRight | −0.22, 0, 0.22 | 0, 1, 0 | 1.47 |

   Why 1.47 N: weight = 0.3 kg × 9.81 = 2.94 N. Four wings at full power give 2 × the weight, so at half power the fly hovers. A brain that starts out "doing nothing" therefore floats instead of dropping like a stone, which makes learning much faster.
4. Sensors (Add component):
   - **Sensors · body state**: velocity, angular velocity, orientation and height all on. The fly feels its tilt and spin, like an insect's balance organs.
   - **Sensors · target**: tag **flower**, frame **world**, range 15. It always knows which way the flower is.

## 3. Make the meadow (World workspace)
1. Press **+** in the viewport toolbar → **Sphere**, then click to place it. Name it *Flower*, size 0.4, colour pink, Physics type **none**, add tag **flower**.
2. Select the spawn point and move it up to y ≈ 0.6 so the fly starts just above the ground.
3. Random flowers: with the Flower selected, press the **X Y Z** randomise buttons in Properties. Set ranges of about x −4…4, y 1.5…4, z −4…4. Every episode then has a new flower position, so the fly learns to fly *anywhere*, not one memorised path.

## 4. Say what success is (Reward workspace)
In the **Reward graph**, right-click the canvas to add nodes and wire them:
- **Approach** (tag *flower*) → **Term** "towards flower", weight **2**
- **Upright** → **Term** "level", weight **0.5**, per second ✓
- **Alive** → **Term** "airborne", weight **0.5**, per second ✓
- all three Terms → **Score**

Then open **Scenarios** (expand the arrow) and add the conditions:
- **Fell over**: parts `root`, tag `ground`, max tilt 80°, min height 0.15 → **fail**, reward −2
- **Reached target**: tag `flower`, radius 0.5, hold 0.5 s → **success**, reward +5
- **Out of bounds** → fail, −2

Set the episode length to **10 s** and frame skip to **2**.

Test it before training: press **Drive by hand** and **Space** (all wings full power). The fly shoots up, and the "airborne" term rises on its own curve.

## 5. Brain and training
1. **Brain** workspace: one **Neural** layer (the default 64 × 64 is enough).
2. **Train** workspace: Method **Reinforcement learning (PPO)**, Learner **auto (GPU if available)**, 8 worlds per worker, step budget 3,000,000 → **Train**.
3. Watch **Live best**. Around 300–500k steps it learns to hover; by about 1M steps it flies to every flower.

## 6. Check and ship
- **Evaluate → All at once**: every saved brain flies to the same flower side by side, from untrained (falls) to best (flies straight there).
- **Export → Unity / Godot / Web / C++**: the four thruster actions and the input order are listed in the package README.

## Going further
- **Heavier fly**: Entity → Prefab & variants → add a variant with mass 0.4. The same brain is now tested on a heavier body.
- **Wind**: Reward → Scenarios → Events → **Push tagged** (tag `fly`) at t = 3 s.
- **Real wings**: use **Body · articulated** with two wing parts on revolute joints, plus a thruster on each wing (part = wing name). The lift then comes from where the wing points.
