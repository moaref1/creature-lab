# Build Smart flies from scratch

Smart Rockets from *The Nature of Code* (chapter 9). A hundred flies are born at the bottom of a room. Each fly has DNA: one force for each moment of its life. They all fly at once. The ones that end closest to the flower get picked as parents, the children mix their parents' DNA and a few genes mutate. In about 60 generations they learn to fly around the wall.

Allow 10 minutes, plus about 10 seconds of training.

## 1. A flat room (World)
1. Logo menu → **New from template…** → **Blank 2D**.
2. Select the world in the Outliner. In Properties set **View: top-down (no gravity)**.
3. Delete the Ground and the Goal (right-click → Delete).
4. Draw the walls: **+** in the viewport toolbar → **Box**, click to place. Make four thin boxes around a 16 × 10 m room and one more across the middle: the obstacle, about 5 m wide. Give each the tag **wall**.
5. Add one more small **Box** near the top, name it *Flower*, tag **flower**, Physics type **none**.
6. Move the **Spawn** point near the bottom.

## 2. The fly (Entity)
1. Go to **Entity**. Select the Agent's **Body · rigid** and set:
   - Shape **box**, Size **0.36 · 0.12 · 0.12**, Mass **1**
   - Linear damping **0**, Friction **0**
   - **Hit agents: off** (flies pass through each other)
   - **Stop when done: on** (a fly that crashes or arrives freezes, like in the book)
2. Remove its sensors and the **move** actuator.
3. **Add component → Sensors · DNA clock**, Genes **60**. This splits the life into 60 moments and tells the brain which moment it is.
4. **Add component → Actuators · steering force**: Max force **6**, Max speed **4**, Face velocity **on**. This is Shiffman's vehicle: force → velocity → position.

## 3. The DNA (Brain)
In **Brain**, select the Neural layer and set **Hidden** to `[]` (no hidden layers). With the DNA clock as its only input, each weight is one gene: the force the fly pushes with at that moment. That is exactly the DNA array from the book.

## 4. Fitness (Reward)
1. In the **Reward graph**: **Approach** (tag *flower*) → **Term** "closer to flower", weight **1** → **Score**. Optionally **Alive** → **Term** "time", weight **−0.05**, per second ✓, so faster flies score higher.
2. **Scenarios** → conditions:
   - **Reached target**: tag `flower`, radius 0.4 → **success**, reward **+10** (the book multiplies fitness by 10)
   - **Hit something**: tag `wall` → **fail**, reward **−1** (the book divides by 10)
3. Episode length **6 s** (the lifespan), frame skip **1**.
4. In the scenario's spawn, set **Count: 100** and **Yaw 90°**. All 100 flies start at the nest.

## 5. Evolve (Train)
1. **Train** → Method **Genetic algorithm (Nature of Code)**:
   - Population **100**, Mutation rate **0.02**, Mutation **replace**
   - Crossover **midpoint**, Fitness power **2**, Elitism **1**
2. Worlds per worker **1**, step budget **3,000,000** → **Train**.
3. In **Live best**, choose **Whole generation**. The whole population flies together with trails, and the readout shows Generation #, Cycles left and Record. In about 60 generations they bend around the wall.

## Going further
- **Seeing flies (neuroevolution)**: replace the DNA clock with **Sensors · target** (tag flower, frame local), **Sensors · raycast** (7 rays, detect wall) and **Sensors · body state**. Set Hidden to `[16]`, Mutation **nudge**, size 0.25, Crossover **uniform**. Randomise the flower's x in Scenarios, so the flies learn to steer to any flower instead of memorising one path. The template has this as its second scenario and config.
- Turn mutation to 0 and watch evolution stall: without mutation no new genes appear.
