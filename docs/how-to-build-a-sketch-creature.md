# Build a sketch creature from scratch

The first web prototype, inside the studio. You draw a creature from **joints**, rigid **bones** and **muscles**, then evolve a brain that contracts and extends the muscles to run.

Allow 5 minutes, plus about 30 seconds of training.

## 1. A flat world (World)
Logo menu → **New from template…** → **Blank 2D**. It already has ground and a spawn point. Delete the Goal.

## 2. Draw the body (Entity)
1. Go to **Entity**. Remove the **Body · rigid**, **move** actuator and **target** sensor from the Agent.
2. **Add component → Body · joints, bones & muscles**. The Entity view switches to the sketch tools, the same ones as the prototype:

   | tool | key | what it does |
   |---|---|---|
   | Joint | J | click empty space to add a joint (5 cm grid) |
   | Bone | B | click two joints to join them with a rigid bone |
   | Muscle | M | click two joints to join them with a muscle |
   | Move | V | drag a joint to reshape the body |
   | Head | H | click a joint to make it the head |
   | Erase | X | click a joint or a link to delete it |

   **Presets…** loads the Walker, Inchworm or Hopper, or clears the body. Ctrl+Z undoes any step.
3. Draw something, or load the Walker. The line under the tools counts joints, bones and muscles and warns you if a joint is not connected or there is no muscle.
4. **Add component → Actuators · muscles**: one action per muscle (−1 contracts, +1 extends).
5. **Add component → Sensors · body sketch**: a rhythm clock, which joints touch the ground, tilt and muscle stretch, the same inputs as the prototype. Optionally add **Sensors · body state** for velocity and height.

## 3. The task (Reward)
1. **Reward graph**: **Progress** (axis x) → **Term** "progress", weight 1 → **Score**. Optionally **Energy used** → **Term** "energy", weight −0.05, per second ✓.
2. **Scenarios** → **Fell over**: parts `head`, tag `ground` → fail. The run ends when the head touches the ground.
3. Episode length **10 s**, frame skip **2**.

## 4. Evolve (Brain and Train)
1. **Brain**: one Neural layer, Hidden `[12]` (like the prototype's 12 hidden neurons).
2. **Train** → Method **Genetic algorithm (Nature of Code)**: Population **48**, Mutation **nudge**, size **0.15**, rate **0.25**, Crossover **uniform**, Elitism **7**. Worlds per worker 1 → **Train**.
3. Watch **Live best**. It usually shuffles forward within about 20 generations and runs over 10 m in 10 s soon after.

## Tips
- Muscles show pink while contracting and blue while extending.
- **Max speed** on the body (default 5 m/s) stops a known trick where creatures vibrate to slide along the ground.
- PPO works too: pick the **PPO** config in the template, or add one in Train.
