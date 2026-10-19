/**
 * Synthetic evaluation data for Lightning's branch router and compaction.
 *
 * All conversations and questions in this file are synthetic, written by hand
 * for this evaluation. They do not come from real users or real systems.
 *
 * Each of the 12 "fact" branches plants one specific fact as the second
 * sentence of its fourth message (message index 3). The matching queries ask
 * about that fact:
 *   - "close" paraphrases share topic words with the branch (for example the
 *     branch name or a key noun) but may still need the planted fact to answer.
 *   - "far" paraphrases describe the same thing without the fact's distinctive
 *     words, so they test whether the router and compaction still find it
 *     when lexical overlap is low.
 *
 * The 4 "distractor" branches share vocabulary with the fact branches but
 * plant no fact and contain none of the 12 answer strings.
 */

export interface EvalMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EvalBranch {
  id: string;
  title: string;
  messages: EvalMessage[];
}

export interface EvalQuery {
  id: string;
  branchId: string;
  question: string;
  answer: string;
  paraphrase: "close" | "far";
}

export const EVAL_BRANCHES: EvalBranch[] = [
  {
    id: "garden",
    title: "Vegetable garden",
    messages: [
      {
        role: "user",
        content:
          "I want to get the vegetable garden in better shape before summer really arrives. The beds look a little thirsty, and I keep forgetting to check them. Could you help me plan a simple watering routine for the tomatoes and beans?",
      },
      {
        role: "assistant",
        content:
          "Automating the watering is the easiest way to stop forgetting about it. A drip system on a timer delivers water slowly right at the roots, which keeps the leaves dry and reduces disease. Set the timer to run for about twenty minutes so the soil soaks through without pooling on the surface.",
      },
      {
        role: "user",
        content:
          "That sounds good, and we already have the hose and the drip line in the shed. Should I also mulch around the plants to hold the moisture in? I worry the soil dries out fast in the afternoon heat, and I would rather not be out there with a watering can every day.",
      },
      {
        role: "assistant",
        content:
          "Mulch is a great idea, and straw tends to work better than bark for holding water in the bed. The drip timer waters the tomato bed at 6:40 every morning. Keep the mulch a few inches away from the stems so the plants do not rot at the base during wet weeks.",
      },
      {
        role: "user",
        content:
          "Good to know about keeping the mulch away from the stems. What about the beans, since they sit in a separate bed on the other side of the fence? I was thinking they might need less water than the tomatoes, but I am not confident about that.",
      },
      {
        role: "assistant",
        content:
          "Beans usually need less water than tomatoes, especially once their roots are established and the plants are growing well. Check the soil with a finger a couple of inches down before you adjust anything on the timer. If it feels dry at that depth, give them a little extra water in the evening so the morning stays calm.",
      },
      {
        role: "user",
        content:
          "Okay, that is a simple test I can remember without writing anything down. Do you think the garden needs fertilizer as well this year, or is the soil already in decent shape from last season's compost?",
      },
      {
        role: "assistant",
        content:
          "A light feeding of compost in the spring is usually enough for a home garden with decent soil. Tomatoes appreciate a bit more potassium once the first fruit starts to set on the vines. Test the soil if you want precise numbers, since too much fertilizer often produces lush leaves and fewer fruits.",
      },
    ],
  },
  {
    id: "taxes",
    title: "Household taxes",
    messages: [
      {
        role: "user",
        content:
          "I need to sort out the household tax situation before the next deadline gets close. Some of our income now comes from freelance work, so the withholding from my regular job is no longer enough. Can you walk me through how estimated payments usually work for a household like ours?",
      },
      {
        role: "assistant",
        content:
          "Estimated payments are made in installments during the year, usually four times, so you do not face a large bill all at once in April. The goal is to pay roughly what you would owe on the income that was not withheld from a paycheck. Your accountant can confirm the exact schedule and thresholds that apply to your situation.",
      },
      {
        role: "user",
        content:
          "That makes sense, and we have been putting money aside in a savings account without any real plan behind it. How do we figure out how much each quarter should be, so we do not overpay or fall short when the year closes?",
      },
      {
        role: "assistant",
        content:
          "A good starting point is last year's total tax bill, divided across the four quarters and adjusted for the new freelance income. Our accountant Priya Raman set the quarterly estimated payment at $3,150. Once the freelance income is clearer over several months, you can update that number with a mid-year check-in.",
      },
      {
        role: "user",
        content:
          "Okay, so we should plan a check-in around the middle of the year and see how the numbers are tracking. Is there anything else we should keep an eye on during the year so that we do not get surprised by the total when the filing season arrives?",
      },
      {
        role: "assistant",
        content:
          "Keep a simple spreadsheet of freelance invoices, the dates they were paid, and any expenses you can deduct against that income. Save receipts for equipment and note mileage for work trips, since those records make the return much easier to complete. Separating business money into its own account also helps a great deal when you are reconciling at year end.",
      },
      {
        role: "user",
        content:
          "I can set up a separate account this weekend and start moving the freelance payments into it right away. What about retirement contributions, do those change the estimated payment at all, or are they handled completely separately from the quarterly math?",
      },
      {
        role: "assistant",
        content:
          "They can change the estimate, because contributions to certain retirement accounts lower your taxable income for the year. If you increase them partway through, the estimated payment for the remaining quarters may drop a little. Ask your accountant before making any large changes so the numbers stay accurate and nothing catches you off guard.",
      },
    ],
  },
  {
    id: "rustbug",
    title: "Rust service crash",
    messages: [
      {
        role: "user",
        content:
          "Our Rust service crashed again overnight, and the logs show a panic somewhere in the buffer code that we wrote last quarter. I am not sure whether it is a concurrency issue or just bad input coming from one of the clients. Could you help me think through how to narrow it down without guessing?",
      },
      {
        role: "assistant",
        content:
          "A panic with a clear location is actually a good sign, because it points you straight at the failing code path. Start by reading the backtrace from the top of the stack down to the first frame that belongs to your own crate. Then check whether the input that triggered it had unusual lengths, empty fields, or values near the limits you expect.",
      },
      {
        role: "user",
        content:
          "The backtrace does point at our own module, so that helps a lot and narrows the search considerably. I can reproduce the crash with a fuzzed packet, but only sometimes, which makes me nervous. Should I add a debug assertion first, or just run the whole thing under the sanitizer?",
      },
      {
        role: "assistant",
        content:
          "Both are worthwhile, and I would begin with the debug assertion because it is cheap to add and quick to run. The panic came from an off-by-one in ring_buffer.rs at line 212. Make sure the assertion checks the write index against the capacity rather than against the current length of the buffer.",
      },
      {
        role: "user",
        content:
          "Makes sense, and I will make sure the assertion uses capacity. Once we fix the index, do we need to change anything about how the buffer wraps around or resizes when it fills up? I would like to avoid introducing a second bug while fixing the first one.",
      },
      {
        role: "assistant",
        content:
          "Probably not, as long as the wrap logic uses the same modulus as the capacity check you just corrected. Write a unit test that fills the buffer exactly to its boundary and then pushes one more item to confirm the behavior. Running that test in a loop will also help catch any intermittent problems that only appear under timing pressure.",
      },
      {
        role: "user",
        content:
          "Good plan, and I will write the boundary test today before anything else on the list. Then I will push the change to the review branch so the rest of the team can look at it and tell me whether they see anything I missed.",
      },
      {
        role: "assistant",
        content:
          "That is a solid next step, and it keeps the change small and easy to reason about during review. Mention in the pull request that the fix is covered by a regression test. Reviewers usually appreciate knowing exactly which failure mode the test is designed to guard against in the future.",
      },
    ],
  },
  {
    id: "lisbon",
    title: "Lisbon trip",
    messages: [
      {
        role: "user",
        content:
          "We are finally planning our trip to Lisbon, and I want to make sure we pick a good base for the visit. We like long walks, quiet mornings, and a view if possible. What neighborhoods would you suggest for a first visit to the city?",
      },
      {
        role: "assistant",
        content:
          "Lisbon is very hilly, so pick a spot where you will not have to climb every single day just to get to a cafe. Many visitors enjoy the older neighborhoods near the river because they feel lively and are very walkable. Quieter streets are nice too, especially if you want to sleep with the windows open at night.",
      },
      {
        role: "user",
        content:
          "The older neighborhoods sound perfect, and I love the idea of the painted tile facades you see in photos. How far is it from the main square to the places with the best viewpoints, roughly speaking, if we decide to walk everywhere?",
      },
      {
        role: "assistant",
        content:
          "Most of the famous viewpoints are a short ride away on the tram or a steep walk up from the older streets. We booked the guesthouse in Alfama for four nights starting May 9. From there, the walk to the top viewpoints usually takes about twenty minutes uphill, depending on how often you stop for photos.",
      },
      {
        role: "user",
        content:
          "Four nights is a good length for us, since we want time for day trips as well as the city itself. Do you have tips for getting from the airport into the city center without renting a car, given that we will have luggage with us?",
      },
      {
        role: "assistant",
        content:
          "The metro is the simplest option from the airport, and a short taxi ride is also fine if you have a lot of bags. Buy a rechargeable transit card at a station kiosk so you can tap in quickly at the gates. Trams are charming, but they fill up fast in the afternoon, so plan around the busiest hours if you can.",
      },
      {
        role: "user",
        content:
          "Great, we will skip the rental car then and rely on transit and our own two feet. What about food? Is it easy to find good dinner spots without reservations, or should we book ahead for the evenings we want to be sure about?",
      },
      {
        role: "assistant",
        content:
          "Many small restaurants take walk-ins, especially if you arrive a little before the evening rush gets going. Try the grilled sardines and a glass of vinho verde at a neighborhood tasca, which is a classic experience. Book ahead only for the very popular places that have just a few tables.",
      },
    ],
  },
  {
    id: "sourdough",
    title: "Sourdough baking",
    messages: [
      {
        role: "user",
        content:
          "My sourdough keeps coming out dense and flat no matter what I try, and I am starting to lose patience with the whole project. The starter seems active when I look at it, but the loaves barely rise in the oven. What should I look at first to figure out what is going wrong?",
      },
      {
        role: "assistant",
        content:
          "Dense loaves usually come from a starter that is not quite at its peak or from dough that was underproofed before baking. Check whether the starter roughly doubles within a few hours after feeding at room temperature. If it does not, the timing of your feedings may be the real issue to address first.",
      },
      {
        role: "user",
        content:
          "I feed it once a day at room temperature, and it often looks a bit sluggish by the evening when I come back to it. Should I change how often I feed it, or should I adjust the amount of flour I use each time I refresh it on the counter?",
      },
      {
        role: "assistant",
        content:
          "A more consistent schedule will help more than changing the flour amount right away. The starter is named Clint and gets fed at a 1:5:5 ratio. Keep it somewhere warm, around 24 degrees, so the yeast and the bacteria stay active through the whole cycle.",
      },
      {
        role: "user",
        content:
          "Okay, a warm spot and a steady routine make sense to me now. How do I know when the dough itself is ready to shape, since the timing on the recipe never seems to match what I see on my kitchen counter at home?",
      },
      {
        role: "assistant",
        content:
          "Look for dough that has grown by about half, shows bubbles around the edges, and jiggles when you gently shake the bowl. Press the surface lightly with a wet finger and see whether it springs back slowly rather than snapping back at once. That slow springback is a good sign the dough is ready to shape.",
      },
      {
        role: "user",
        content:
          "I will watch for the jiggle and the slow springback from now on, and I will write the times in a notebook so I can compare them. Any tips for scoring the top of the loaf so that it opens up nicely in the oven instead of tearing?",
      },
      {
        role: "assistant",
        content:
          "Use a very sharp blade and make one confident cut about a centimeter deep rather than several hesitant ones. Hold the blade at a low angle so the top opens in a clean ear as the loaf expands. Score right before the loaf goes into the oven, since the surface should be cool to the touch but not dry.",
      },
    ],
  },
  {
    id: "car",
    title: "Car maintenance",
    messages: [
      {
        role: "user",
        content:
          "The car has been making a squealing sound on cold mornings, and I want to get it looked at before it turns into a bigger and more expensive problem. I do not know much about engines, so please keep the explanations simple. Where should I start when I describe it to the shop?",
      },
      {
        role: "assistant",
        content:
          "A squeal on cold starts often points to a belt that is worn or slightly loose. Listen closely to see whether the sound is constant or only appears when the engine first turns over in the morning. A short inspection by a mechanic will usually answer that question quickly and without much fuss.",
      },
      {
        role: "user",
        content:
          "It only squeals for the first minute or two after starting, and then it quiets down once the engine has warmed up. Could that still be the belt even though it stops once the engine gets going, or is it something else entirely that I should mention?",
      },
      {
        role: "assistant",
        content:
          "Yes, a worn belt can squeal when it is cold because the rubber is stiffer and grips the pulleys less well. The mechanic replaced the serpentine belt and set the next service for 92,000 miles. Ask them to check the tensioner while they have the cover off, since a weak tensioner can cause the same noise.",
      },
      {
        role: "user",
        content:
          "That is helpful, and it gives me a clear list of things to ask the shop about. How often should I actually check the oil and the tire pressure myself between visits, rather than relying on the dashboard warning lights to tell me when something is wrong?",
      },
      {
        role: "assistant",
        content:
          "Checking the oil once a month is a good habit, and the same goes for the tire pressure on all four wheels. Use the number printed on the sticker inside the driver's door rather than the maximum printed on the tire sidewall. Cold weather lowers tire pressure, so check more often during the winter months when temperatures drop quickly.",
      },
      {
        role: "user",
        content:
          "I will add a monthly reminder on my phone so I stop forgetting about it. What about the battery as well, since the mornings have been really cold lately and the car seems to take longer to turn over than it used to?",
      },
      {
        role: "assistant",
        content:
          "Cold temperatures can make a weak battery struggle to start the engine, so a slow crank is worth paying attention to. Have it tested at a shop, which usually takes only a few minutes and is often free. Replacing an aging battery before winter is far cheaper than being stuck in a parking lot with a dead car.",
      },
    ],
  },
  {
    id: "pgmigration",
    title: "Postgres upgrade",
    messages: [
      {
        role: "user",
        content:
          "We are preparing to upgrade the production database next month, and the team is understandably nervous about any downtime for customers. I want to know what a sensible cutover plan looks like from start to finish. Can you help me outline the main steps we should cover?",
      },
      {
        role: "assistant",
        content:
          "A good cutover plan starts with a full rehearsal on a copy of production data, which shows you what will actually happen. Measure how long the dump and the restore take, and note any extensions that need to be reinstalled afterward. Then write down a clear go or no-go checklist for the day itself so the decision is not made under stress.",
      },
      {
        role: "user",
        content:
          "We already rehearsed once, and the restore took a little over an hour, which felt reasonable. Should we schedule the switch for a low-traffic window, and how do we make sure that the window really is low traffic rather than just assumed?",
      },
      {
        role: "assistant",
        content:
          "Pick the window based on real traffic graphs from the last few months rather than on gut feeling about when things are quiet. The Postgres 17 cutover runs on the night of the 14th and Marcus owns the rollback. Keep the rollback steps written down and tested so they can be carried out without guesswork if the night goes badly.",
      },
      {
        role: "user",
        content:
          "Good, so there is one person who owns the rollback decision, which removes any confusion about who calls it. What metrics should we watch during the cutover so we know early on whether it is going well or whether we need to act?",
      },
      {
        role: "assistant",
        content:
          "Watch connection counts, query latency at the ninety-fifth percentile, and replication lag if you have replicas running. Error rates in the application logs are also worth a dedicated dashboard for the night. Agree on the thresholds before the night starts so nobody has to debate them while the clock is running.",
      },
      {
        role: "user",
        content:
          "We will agree on the thresholds in the planning meeting on Thursday, and I will put them in the runbook. Do we also need to freeze schema changes during that week, or is a freeze only necessary on the actual night of the cutover itself?",
      },
      {
        role: "assistant",
        content:
          "Yes, a freeze for the whole week of the cutover keeps the variables small and makes the rollback much simpler to reason about. Communicate the freeze to every team that deploys against the database so nobody is surprised. Any exceptions should go through the same owner who runs the rollback, so there is one point of decision.",
      },
    ],
  },
  {
    id: "party",
    title: "Mia's birthday party",
    messages: [
      {
        role: "user",
        content:
          "Mia turns seven next month, and she has asked for a backyard party with a few of her closest friends from school. I am trying to plan the food and the games without going overboard on the budget or on my own energy. Where should I begin with all of this?",
      },
      {
        role: "assistant",
        content:
          "Start with the guest count and the time of day, since those two decisions shape almost everything else you will plan. A mid-afternoon party works well for kids because it avoids nap time and the dinner rush that can make everyone cranky. Keep the menu simple, with a few finger foods and one special dessert that everyone can share.",
      },
      {
        role: "user",
        content:
          "Sixteen kids seems like a lot to manage in the backyard, even though most of them already know each other from school. Should I plan structured games for the whole group, or would it be better to let them play freely and just step in when someone needs help?",
      },
      {
        role: "assistant",
        content:
          "A mix works best, with one or two organized games and plenty of free time in between. The cake is lemon with raspberry filling from Ruth's bakery. Keep the group together for the first game so that nobody feels left out before the party really gets going.",
      },
      {
        role: "user",
        content:
          "Okay, the cake is taken care of then, which is a relief after the long list I had been working through. What about party favors? Are they worth the effort for a group that size, or will they just end up as clutter in the house afterward?",
      },
      {
        role: "assistant",
        content:
          "Small favors are a nice touch, but they can add up quickly with a big guest list and a limited budget. Consider one simple item like a sticker sheet or a bubble wand that the kids will actually use. Put the favors in paper bags so the children can carry them home easily at the end of the afternoon.",
      },
      {
        role: "user",
        content:
          "Bubble wands are cheap, and the kids will love them in the yard on a sunny afternoon. Do you have a rough idea of how many games fit into a two hour party without it feeling rushed or dragging for the younger children who get tired?",
      },
      {
        role: "assistant",
        content:
          "Three or four short activities usually fill about two hours without anyone getting bored or restless. Leave a stretch in the middle for food and cake so the energy has a natural break. Build in a few minutes of buffer so the schedule can slide a little without causing any stress for you.",
      },
    ],
  },
  {
    id: "network",
    title: "Home network",
    messages: [
      {
        role: "user",
        content:
          "We are going to set up a separate network for guests so that visitors do not end up on our main devices by accident. I am not sure about the best name for it or which settings matter most. Can you help me think through the basics before I log in to the router?",
      },
      {
        role: "assistant",
        content:
          "A guest network is a great idea because it keeps visitor devices away from printers, file shares, and the smart home gear. Most modern routers can create one with its own password and an optional time limit. Make sure guests can still reach the internet while being unable to see your internal devices on the main network.",
      },
      {
        role: "user",
        content:
          "Our router is fairly new, so I think it supports a second network without much trouble. Which Wi-Fi channel should I choose for the guest network so that it does not interfere with the main one and cause slow connections for everyone?",
      },
      {
        role: "assistant",
        content:
          "Picking a clear channel makes a real difference in speed and stability for everyone on the connection. The new guest network is called OwlNest-Guest on channel 11. Check that the router is not using the same channel on both bands, since that can cause interference between the two networks.",
      },
      {
        role: "user",
        content:
          "Got it, and that should keep things smooth for everyone in the house. Should I use a stronger password for guests, or is the usual one fine since the access is only temporary and visitors come and go on their own schedule?",
      },
      {
        role: "assistant",
        content:
          "Use a separate password that is different from the one on your main network, even if it feels like overkill. Change it every few months, or after a large group of visitors has left the house. Printing the password on a small card for guests is simple and saves you from repeating it again and again.",
      },
      {
        role: "user",
        content:
          "A card on the fridge is an easy solution that the whole family will understand right away. Do I need to do anything special for the kids' tablets, since they sometimes join the main network by themselves when we are not paying attention to them?",
      },
      {
        role: "assistant",
        content:
          "Move the tablets to the guest network only if they are not managed by parental controls, because those restrictions may stop working on a different network. Otherwise the filters can quietly fail without anyone noticing. Test one device first before changing the rest, so you can confirm everything still behaves as expected.",
      },
    ],
  },
  {
    id: "marathon",
    title: "Marathon training",
    messages: [
      {
        role: "user",
        content:
          "I signed up for my first marathon in the spring, and I am feeling a bit anxious about the long runs that are coming. My weekly mileage is building up slowly, but I really want to avoid getting hurt before race day. Can you help me understand the overall structure of a good plan?",
      },
      {
        role: "assistant",
        content:
          "Most first-time marathon plans build gradually over roughly sixteen to twenty weeks rather than jumping in all at once. Weekly mileage rises in steps, with an easier recovery week after every few harder weeks. The long run is the anchor of the whole plan, so protect that session on the calendar before anything else.",
      },
      {
        role: "user",
        content:
          "I have been running about thirty kilometers a week lately and I feel fine most of the time. How quickly should I add distance to the long run each week, so that I build steadily without pushing too hard too early in the cycle?",
      },
      {
        role: "assistant",
        content:
          "Adding roughly one or two kilometers each week is a steady pace for most runners who are already comfortable. The plan peaks with a 32 km long run three weeks before race day. Taper the final weeks so your legs have time to recover before you reach the start line on the morning of the race.",
      },
      {
        role: "user",
        content:
          "Three weeks out seems like a good point to start tapering, then, which means the hardest work is already behind me. What should I eat and drink on the long runs themselves, since I have not really practiced that part of the training yet?",
      },
      {
        role: "assistant",
        content:
          "Practice fueling during long runs, because your stomach needs time to adapt to food while moving. Start with small amounts of carbohydrate every forty minutes or so, and adjust from there based on how you feel. Keep the same routine on race day so that nothing unfamiliar surprises you halfway through the course.",
      },
      {
        role: "user",
        content:
          "I will try a gel and a sports drink on the next long run to see how my stomach handles them. Should I also be worried about the occasional sore knee or shin, or is that just part of building mileage that everyone experiences at some point?",
      },
      {
        role: "assistant",
        content:
          "Some soreness is normal early on, but sharp pain that lingers from one run to the next is a sign to back off. Strength work for the hips and calves can reduce many of the common problems in new marathon runners. If pain persists for more than a few days, see a physiotherapist before you push through it.",
      },
    ],
  },
  {
    id: "bookclub",
    title: "Book club",
    messages: [
      {
        role: "user",
        content:
          "Our book club meets again this weekend, and I still have not picked up the reading for the current title. Everyone seems excited about the next book, but I lost track of the schedule somewhere along the way. Can you give me a quick overview of how groups like ours usually choose their books?",
      },
      {
        role: "assistant",
        content:
          "Many clubs rotate the pick so that each member chooses a book in turn over the year. Some groups vote from a shortlist of several titles, which keeps the choice fair and fairly quick to settle. The important part is that everyone agrees to read the book before the meeting so the conversation can actually happen.",
      },
      {
        role: "user",
        content:
          "We have been voting from a shortlist for a while now, and I would like to suggest something with a bit of science fiction in it this time. Do you have any ideas for a book that will lead to a strong discussion among a group of readers who are not all fans of the genre?",
      },
      {
        role: "assistant",
        content:
          "Science fiction is great for discussions because it asks big questions about society, freedom, and how people live together. This month the club picked The Dispossessed by Ursula K. Le Guin. Its two contrasting worlds give plenty of material for comparing ideas and arguing about which system is better.",
      },
      {
        role: "user",
        content:
          "That is a great pick, and I have heard the first chapters can be slow before the story really opens up for readers. How many pages should we aim to read each week so that we finish comfortably before the next meeting arrives on the calendar?",
      },
      {
        role: "assistant",
        content:
          "Divide the total number of pages by the number of weeks you have before the meeting, then aim for a little less than that. That leaves room for the slow chapters and for the weeks when everyone is busy with other things. Note a few questions as you go along, since that makes the discussion much richer when you get together.",
      },
      {
        role: "user",
        content:
          "Great, I will make a reading schedule and share it in the group chat so everyone can see it at a glance. Should we invite anyone new to the club this time, or would that change the feel of the group too much for the regulars who have been meeting for years?",
      },
      {
        role: "assistant",
        content:
          "Inviting one or two new people can refresh the conversation without disrupting the group too much. Send them the schedule ahead of time so they can join the reading easily and feel prepared. Keep the meeting relaxed so newcomers feel welcome and do not feel tested on the book.",
      },
    ],
  },
  {
    id: "kitchen",
    title: "Kitchen renovation",
    messages: [
      {
        role: "user",
        content:
          "We are finally renovating the kitchen, and I want to understand the budget clearly before we commit to anything. The old cabinets are falling apart in a few places and the counters are cracked near the sink. Where should we start the planning so that nothing important gets missed?",
      },
      {
        role: "assistant",
        content:
          "Start with a clear list of what you must replace and what you would simply like to upgrade if the money allows. Get at least three written quotes so you can compare the scope of work and the materials each one includes. A contingency of around ten percent helps a lot when old walls hide surprises behind them.",
      },
      {
        role: "user",
        content:
          "We have a rough idea of the layout already, and we want to keep the sink where it currently sits to avoid moving the plumbing. Should we pick the appliances first, or should we settle on the cabinets and then fit the appliances around them later?",
      },
      {
        role: "assistant",
        content:
          "Choose the appliances early, because their sizes affect the cabinet layout more than most people expect. The contractor quoted $18,400 for the cabinets and quartz counters. Ask whether that figure includes installation as well as the removal of the old cabinets and countertops.",
      },
      {
        role: "user",
        content:
          "That is helpful, and it sounds like the quote does not include removal of the old pieces yet, which I should have asked about. What about permits? Do we need them for moving the plumbing if we decide to shift the sink a little bit to the left?",
      },
      {
        role: "assistant",
        content:
          "Moving plumbing usually needs a permit, and the inspector will check the work before the walls are closed up again. Ask your contractor who handles the paperwork, since some firms include it and others expect the homeowner to file. Clear permits also protect you when you eventually sell the house and a buyer asks about the work.",
      },
      {
        role: "user",
        content:
          "I will ask them to include the permit and the removal in the estimate so we can compare the numbers properly. How long does a project like this usually take from start to finish, including the time spent waiting for materials to be delivered?",
      },
      {
        role: "assistant",
        content:
          "A typical kitchen renovation takes six to ten weeks once the work actually begins on site. Cabinets and counters often have long lead times, so order them as early as you can after the design is settled. Build in a buffer for delays in deliveries and inspections so the schedule does not feel like a failure when it slips.",
      },
    ],
  },
  {
    id: "lawn",
    title: "Lawn care",
    messages: [
      {
        role: "user",
        content:
          "The front lawn looks patchy this summer, and I want to bring it back to life before the autumn rains arrive. I have a sprinkler system already installed, but I am not sure I am using it correctly for the grass. Can you help me understand a good watering pattern for a lawn like ours?",
      },
      {
        role: "assistant",
        content:
          "Deep, infrequent watering is better than short daily sprinkles for most lawns in warm weather. Aim for roughly an inch of water per week in total, counting any rain that has already fallen. Watering in the early morning reduces evaporation and gives the grass time to dry before the evening, which discourages fungus.",
      },
      {
        role: "user",
        content:
          "My timer currently runs every evening for about ten minutes, which is probably far too short to soak the roots. Would switching the schedule to the morning change much for the grass, or is it mainly a question of how long each cycle runs?",
      },
      {
        role: "assistant",
        content:
          "Yes, morning watering usually helps because the blades dry quickly and fungus has less time to take hold overnight. Adjust the timer so the cycle finishes before the sun gets hot and starts to evaporate the water. Check the sprinkler heads for clogs or spray that is pointing at the driveway instead of the grass.",
      },
      {
        role: "user",
        content:
          "I will check the heads this weekend and clear out anything that looks blocked or misaligned. Should I overseed the bare spots at the same time while I am out there with the tools, or does that need to wait until the weather changes?",
      },
      {
        role: "assistant",
        content:
          "Overseeding in early autumn works best, because the soil is still warm and rain is more common than it is in midsummer. Rake the bare patches lightly and spread a thin layer of seed over them evenly. Keep the area moist until the new grass is a few centimeters tall and has settled into the soil.",
      },
      {
        role: "user",
        content:
          "That sounds manageable, and I can handle it in a single afternoon with the right tools in the shed. Do I need to mow differently while the new grass is coming in, or can I keep my usual routine without damaging the young seedlings?",
      },
      {
        role: "assistant",
        content:
          "Set the mower a little higher so the blades shade the soil and help keep it moist during the early weeks. Avoid cutting more than about a third of the blade length at any one time. Wait until the new seedlings are well established before the first mow, so the young roots are not pulled up.",
      },
    ],
  },
  {
    id: "insurance",
    title: "Car insurance renewal",
    messages: [
      {
        role: "user",
        content:
          "Our car insurance renewal arrived this week, and the premium went up by quite a bit compared with last year. I want to know whether we can lower it without dropping any coverage that actually matters for us. Where do you think we should start looking at the options?",
      },
      {
        role: "assistant",
        content:
          "Start by comparing the coverage limits and the deductibles rather than focusing only on the monthly premium. A higher deductible can reduce the cost, but make sure you could pay it comfortably if you ever needed to make a claim. Also ask whether any discounts apply that were not added automatically when the policy was first set up.",
      },
      {
        role: "user",
        content:
          "We drive less than we used to, since one of us now works from home most days of the week. Does the annual mileage affect the quote very much, or is it a small factor compared with things like the driver's age and the vehicle itself?",
      },
      {
        role: "assistant",
        content:
          "Annual mileage is a major factor in most quotes, and lower miles often earn a noticeable discount from the insurer. Give the company an accurate estimate of how many miles each car is driven in a typical year. Keep a record of the odometer reading so the number is easy to confirm if the insurer asks for it later.",
      },
      {
        role: "user",
        content:
          "That is a good idea, and I will read the odometer at the start of each month and write it down on the fridge calendar. What about bundling the car policy with the home policy? Is that worth checking, or does it usually end up costing about the same overall?",
      },
      {
        role: "assistant",
        content:
          "Bundling often saves money, although it is worth comparing the separate prices too before you commit to anything. Some insurers offer loyalty discounts after several years with the same company, which can be easy to overlook. Get at least three quotes so you can compare the total annual cost fairly across the different providers.",
      },
      {
        role: "user",
        content:
          "I will gather three quotes next week and put them side by side in a simple table so the comparison is easy. Is there a reliable way to tell whether a new insurance company will actually pay claims promptly when something goes wrong on the road?",
      },
      {
        role: "assistant",
        content:
          "Look at independent customer reviews and the regulator's published complaint records for each insurer you are considering. Ask friends or neighbors who have filed a claim recently how the process went from start to finish. A fair premium matters much less if the claim process turns out to be slow or unclear when you actually need it.",
      },
    ],
  },
  {
    id: "officewifi",
    title: "Office Wi-Fi outage",
    messages: [
      {
        role: "user",
        content:
          "The office Wi-Fi dropped three times this morning, and people could not join their video meetings for a while. I need to figure out whether the problem is the router or something else in the building. Can you help me work through the most likely causes in a sensible order?",
      },
      {
        role: "assistant",
        content:
          "Start by checking whether the outage affected everyone or only certain floors and certain devices. Look at the router logs for disconnects and error messages around the times when people reported problems. Interference from neighboring networks in the building can also cause brief drops that feel random to the people using the connection.",
      },
      {
        role: "user",
        content:
          "The drops seemed to happen on the second floor first, and then they spread a little to the others. The logs also show a lot of retries on the same channel during those windows. Could that be the main issue here, or is there something else I should check on the hardware side?",
      },
      {
        role: "assistant",
        content:
          "Repeated retries often point to channel interference, especially in crowded buildings with many networks nearby. Changing to a less busy channel frequently fixes the problem without any new hardware being needed. Test the new channel during the working day, since that is when the load on the network is highest and problems show up.",
      },
      {
        role: "user",
        content:
          "I will try that after lunch, when the building is at its busiest and I can see whether the change actually holds. Also, visitors need guest access to the internet in the lobby, so I want to make sure that stays properly separate from the staff network.",
      },
      {
        role: "assistant",
        content:
          "Keeping guest access on its own network is a good practice for security and it limits what visitors can reach. Restrict guest devices so they cannot see internal printers, file servers, or the management pages of the equipment. Confirm that the guest password still works after the channel change, since some routers reset those settings.",
      },
      {
        role: "user",
        content:
          "Okay, I will test both networks once the channel is switched and write down what I see during each test. If the outage returns next week, what exactly should I send to the vendor so they can help me quickly without a long back and forth?",
      },
      {
        role: "assistant",
        content:
          "Send the log excerpts with their timestamps, the affected floors, and the number of devices connected at each time. Include a short description of anything that changed recently, such as a firmware update or a new device being added. The more specific your report is, the faster the vendor can narrow down the problem for you.",
      },
    ],
  },
  {
    id: "cakeclass",
    title: "Cake decorating class",
    messages: [
      {
        role: "user",
        content:
          "I signed up for a cake decorating class next month, and I am nervous because my piping always looks messy when I try it at home. Could you give me a few basic things to practice before the first session? I have a few hours each week to spare for the practice.",
      },
      {
        role: "assistant",
        content:
          "Practice straight lines and even dots with buttercream on a plate before you ever try it on a cake. Hold the piping bag steady with one hand at the top and apply gentle, even pressure as you move. Consistency matters much more than speed when you are learning, so take your time with each stroke.",
      },
      {
        role: "user",
        content:
          "My frosting is often too soft, and it slides off the sides of the cake before I have finished decorating the top. What do I need to change in my method or my ingredients so that it holds its shape for the whole session?",
      },
      {
        role: "assistant",
        content:
          "Chill the frosting for a short time so it firms up without becoming hard to pipe through the tip. Use a good ratio of butter to sugar and add any liquid slowly rather than all at once. Check the temperature of the room as well, since a warm kitchen softens frosting quite quickly while you are working.",
      },
      {
        role: "user",
        content:
          "That makes sense, and I will try chilling the bowl for ten minutes between sections. The class also mentioned filling the layers, and I am not sure how to keep the middle from squishing out the sides when I press the top layer down.",
      },
      {
        role: "assistant",
        content:
          "Use a dam of stiff frosting around the outer edge of the layer before you add anything into the center. Spread the filling gently so it does not push past the dam and run down the sides. Chill the layers briefly so they are firm enough to stack without sliding around on the board.",
      },
      {
        role: "user",
        content:
          "I will try that with a practice cake this weekend, and I will write down how each step goes so I can see what works. Do you have any tips for getting a smooth finish on the outside of the cake before the class starts next month?",
      },
      {
        role: "assistant",
        content:
          "A bench scraper and a warm offset spatula help a great deal for smooth sides, and they are both inexpensive. Work in thin passes and wipe the tool clean between strokes so the crumbs do not drag through the frosting. Chill the cake between coats so the crumb coat stays put while you add the final layer.",
      },
    ],
  },
];

export const EVAL_QUERIES: EvalQuery[] = [
  {
    id: "garden-close",
    branchId: "garden",
    question: "What time does the drip timer water the tomatoes?",
    answer: "6:40",
    paraphrase: "close",
  },
  {
    id: "garden-far",
    branchId: "garden",
    question: "When do the vegetables get irrigated each day?",
    answer: "6:40",
    paraphrase: "far",
  },
  {
    id: "taxes-close",
    branchId: "taxes",
    question: "What amount did Priya Raman set for the quarterly estimated tax payment?",
    answer: "3,150",
    paraphrase: "close",
  },
  {
    id: "taxes-far",
    branchId: "taxes",
    question: "How much did our accountant decide we should send in each quarter for estimated taxes?",
    answer: "3,150",
    paraphrase: "far",
  },
  {
    id: "rustbug-close",
    branchId: "rustbug",
    question: "Which line in ring_buffer.rs caused the panic?",
    answer: "212",
    paraphrase: "close",
  },
  {
    id: "rustbug-far",
    branchId: "rustbug",
    question: "What line number was the crash traced back to in that buffer file?",
    answer: "212",
    paraphrase: "far",
  },
  {
    id: "lisbon-close",
    branchId: "lisbon",
    question: "Which neighborhood is the guesthouse in for the Lisbon trip?",
    answer: "Alfama",
    paraphrase: "close",
  },
  {
    id: "lisbon-far",
    branchId: "lisbon",
    question: "Where are we staying in the city during our visit to Portugal's capital?",
    answer: "Alfama",
    paraphrase: "far",
  },
  {
    id: "sourdough-close",
    branchId: "sourdough",
    question: "What is the starter's name, and how often do we feed it?",
    answer: "Clint",
    paraphrase: "close",
  },
  {
    id: "sourdough-far",
    branchId: "sourdough",
    question: "What did we call the sourdough culture we keep on the counter?",
    answer: "Clint",
    paraphrase: "far",
  },
  {
    id: "car-close",
    branchId: "car",
    question: "At what mileage is the next car service scheduled?",
    answer: "92,000",
    paraphrase: "close",
  },
  {
    id: "car-far",
    branchId: "car",
    question: "At what odometer reading is the vehicle due for its next maintenance visit?",
    answer: "92,000",
    paraphrase: "far",
  },
  {
    id: "pgmigration-close",
    branchId: "pgmigration",
    question: "Who is responsible for the Postgres 17 rollback?",
    answer: "Marcus",
    paraphrase: "close",
  },
  {
    id: "pgmigration-far",
    branchId: "pgmigration",
    question: "Which teammate is on the hook if the database upgrade has to be undone?",
    answer: "Marcus",
    paraphrase: "far",
  },
  {
    id: "party-close",
    branchId: "party",
    question: "What flavor is the birthday cake for Mia's party?",
    answer: "lemon",
    paraphrase: "close",
  },
  {
    id: "party-far",
    branchId: "party",
    question: "What citrus flavor did we settle on for the celebration dessert?",
    answer: "lemon",
    paraphrase: "far",
  },
  {
    id: "network-close",
    branchId: "network",
    question: "What is the name of the new guest network on the home router?",
    answer: "OwlNest-Guest",
    paraphrase: "close",
  },
  {
    id: "network-far",
    branchId: "network",
    question: "What SSID should visitors pick when they join our Wi-Fi at home?",
    answer: "OwlNest-Guest",
    paraphrase: "far",
  },
  {
    id: "marathon-close",
    branchId: "marathon",
    question: "How long is the longest run in the marathon training plan?",
    answer: "32 km",
    paraphrase: "close",
  },
  {
    id: "marathon-far",
    branchId: "marathon",
    question: "How far is the peak training run before the race?",
    answer: "32 km",
    paraphrase: "far",
  },
  {
    id: "bookclub-close",
    branchId: "bookclub",
    question: "Which novel did the book club choose this month?",
    answer: "Dispossessed",
    paraphrase: "close",
  },
  {
    id: "bookclub-far",
    branchId: "bookclub",
    question: "What title did the reading group settle on for this month?",
    answer: "Dispossessed",
    paraphrase: "far",
  },
  {
    id: "kitchen-close",
    branchId: "kitchen",
    question: "How much did the contractor quote for the cabinets and counters?",
    answer: "18,400",
    paraphrase: "close",
  },
  {
    id: "kitchen-far",
    branchId: "kitchen",
    question: "What price did the builder give for the kitchen cabinetry and countertops?",
    answer: "18,400",
    paraphrase: "far",
  },
];

/** Lower-case, strip commas, collapse whitespace; true when the normalized answer appears in the normalized text. */
export function answerMatches(text: string, answer: string): boolean {
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();
  return normalize(text).includes(normalize(answer));
}
