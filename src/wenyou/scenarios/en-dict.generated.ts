// 自动生成：文游剧本 UI 可见字段的英文词典（temp/gen-wenyou-en.mjs 产出，人工复核后保留）
// 仅覆盖界面显示字段；剧情正文/事件池保持中文，AI 叙事按用户语言实时生成。
export const SCENARIO_EN: Record<string, any> = {
  "xian": {
    "id": "xian",
    "title": "The Mystic Immortal Path",
    "genre": "Xianxia",
    "intro": "Born a mere mortal, you stumble upon the path of cultivation. From breathing exercises to forming a golden core, from sect politics to heavenly tribulations—on the road to immortality, myriad races compete, and inner demons lurk. One wrong step could cost you your cultivation, or even your life. On this ethereal immortal path, seek the Dao, and seek a life without regret.",
    "turnUnit": "Cycle",
    "attributes": [
      {
        "key": "cultivation",
        "name": "Cultivation",
        "bands": [
          "Qi Refining",
          "Foundation Establishment",
          "Golden Core",
          "Nascent Soul",
          "Spirit Severing·Tribulation"
        ]
      },
      {
        "key": "daoHeart",
        "name": "Dao Heart",
        "bands": [
          "Devoured by Inner Demons",
          "Dao Heart Unstable",
          "Dao Heart at Ease",
          "Dao Heart Luminous"
        ]
      },
      {
        "key": "lifespan",
        "name": "Lifespan",
        "bands": [
          "Lifespan Nearly Exhausted",
          "Lifespan Waning",
          "In Prime of Life",
          "Lifespan Enduring"
        ]
      }
    ],
    "openings": [
      {
        "name": "Rogue Cultivator",
        "prompt": "A rogue cultivator from humble origins, with impure spiritual roots and no backing, whose entire cultivation is earned through brushes with death."
      },
      {
        "name": "Sect Disciple",
        "prompt": "A formal disciple of a prestigious sect, with ample resources and protective elders, yet bound by rules, hierarchy, and sect politics."
      },
      {
        "name": "Heretic Survivor",
        "prompt": "Heir to a demonic art, cultivating swiftly and ruthlessly, but rejected by the orthodox and haunted by inner demons and pursuers."
      }
    ],
    "ambitions": [
      "Attain enlightenment and ascend, transcending reincarnation",
      "Form a golden core and make your mark in the cultivation world",
      "Avenge the massacre of your clan",
      "Seek the secret of eternal life",
      "Slay all inner demons and seek ultimate freedom",
      "Forge a legendary natal treasure",
      "Found a sect and pass down your teachings",
      "Survive the nine heavenly tribulations and join the immortals",
      "Find your lost dao companion from a past life",
      "Defy destiny and rewrite your own fate"
    ],
    "endings": [
      {
        "condition": "daoHeart<=0",
        "tone": "Inner Demons Consume·Death and Dao Extinction"
      },
      {
        "condition": "lifespan<=0",
        "tone": "Lifespan Exhausted·Passing in Meditation"
      },
      {
        "condition": "lifespan<=-1",
        "tone": "Ascension·Becoming an Immortal"
      },
      {
        "condition": "lifespan<=-1",
        "tone": "Escaping the Three Realms·Beyond the Five Elements"
      },
      {
        "condition": "has(化神) & cultivation>=93 & daoHeart<=30",
        "tone": "Forcing the Tribulation·Obliteration of Form and Spirit"
      },
      {
        "condition": "daoHeart<=6",
        "tone": "Inner Demons Seize·Falling into Demonhood"
      },
      {
        "condition": "lifespan<=8 & has(云清) & cultivation>=70",
        "tone": "Immortal Lovers·Flying Together"
      },
      {
        "condition": "lifespan<=8 & has(云清)",
        "tone": "Cultivating Together·A Lifetime Together"
      },
      {
        "condition": "lifespan<=8 & has(化神) & cultivation>=96 & daoHeart>=80",
        "tone": "Peak of Mahayana·Earthbound Immortal"
      },
      {
        "condition": "lifespan<=8 & has(化神)",
        "tone": "Ascension in Death·Dao Remains"
      },
      {
        "condition": "lifespan<=8 & has(元婴) & daoHeart>=82",
        "tone": "Nascent Soul Roams·Traversing the Mortal World"
      },
      {
        "condition": "lifespan<=8 & has(元婴)",
        "tone": "Nascent Soul Passes·Legacy for Ages"
      },
      {
        "condition": "lifespan<=8 & has(金丹) & daoHeart>=82",
        "tone": "Golden Core Enlightenment·Returning to True Self"
      },
      {
        "condition": "lifespan<=8 & has(金丹)",
        "tone": "Golden Core Life Ends·A Thousand Years"
      },
      {
        "condition": "lifespan<=8 & cultivation<=66 & daoHeart>=96",
        "tone": "Pure Insight·One Thought of Truth"
      },
      {
        "condition": "lifespan<=8 & cultivation<=66 & daoHeart>=88 & has(散修)",
        "tone": "Rogue's Heart·Self-Evident Clarity"
      },
      {
        "condition": "lifespan<=8 & cultivation<=66 & daoHeart>=88 & has(仙门)",
        "tone": "Humble Return·Honoring the Sect"
      },
      {
        "condition": "lifespan<=8 & cultivation<=66 & daoHeart>=88 & has(筑基)",
        "tone": "Foundation Clarity·Great Dao in Small Realm"
      },
      {
        "condition": "lifespan<=8 & cultivation<=66 & daoHeart>=88",
        "tone": "Dao Heart Perfected·Peace Without Leak"
      },
      {
        "condition": "lifespan<=8 & has(筑基)",
        "tone": "Foundation Elder·Years in the Mountains"
      },
      {
        "condition": "lifespan<=8 & cultivation<=35 & daoHeart>=60",
        "tone": "Retiring to the Mountains·Returning to Simplicity"
      },
      {
        "condition": "lifespan<=8 & cultivation<=18 & daoHeart<=40",
        "tone": "Qi Refining Drift·Lost Among Mortals"
      },
      {
        "condition": "lifespan<=8 & has(散修)",
        "tone": "Nameless Rogue·Wild Crane and Free Cloud"
      },
      {
        "condition": "lifespan<=8 & has(仙门)",
        "tone": "Sect Disciple·Attaining the Dao"
      },
      {
        "condition": "lifespan<=8 & has(魔道)",
        "tone": "Demonic Rise and Fall·Ending in Dust"
      },
      {
        "condition": "lifespan<=-1",
        "tone": "Stumbling into a Killing Array·Sudden Death"
      },
      {
        "condition": "lifespan<=-1",
        "tone": "Cursed by Malevolence·Dying in the Wild"
      },
      {
        "condition": "lifespan<=-1",
        "tone": "Favor of Immortal Fate·Leaping to Glory"
      }
    ]
  },
  "book": {
    "id": "book",
    "title": "Transmigrated into a Book",
    "genre": "Time Travel",
    "intro": "After staying up all night reading the melodramatic novel 'Phoenix Tribulation', you wake up to find yourself transmigrated into the body of a minor cannon fodder character who dies in Chapter 3. The plot has thirty more chapters until it reaches the ending you know—unless you rewrite it.",
    "turnUnit": "Chapter",
    "attributes": [
      {
        "key": "plot",
        "name": "Plot Divergence",
        "bands": [
          "Following the Original",
          "Emerging Changes",
          "World-Altering"
        ]
      },
      {
        "key": "favor",
        "name": "Protagonist's Favor",
        "bands": [
          "Sworn Enemy",
          "Wary",
          "Acquainted",
          "Trusted"
        ]
      },
      {
        "key": "safety",
        "name": "Safety Value",
        "bands": [
          "Hanging by a Thread",
          "Perilous",
          "Safe",
          "Unshakeable"
        ]
      }
    ],
    "openings": [
      {
        "name": "Vicious Female Lead Rival",
        "prompt": "A noble lady who antagonizes the heroine in the original and is killed off by Chapter 3—high-born yet with a sealed fate."
      },
      {
        "name": "Villain's Daughter",
        "prompt": "The only daughter of the great villain, destined to fall with her father's clan, raised in seclusion yet at the heart of power struggles."
      },
      {
        "name": "Dowry Maidservant",
        "prompt": "A lowly maidservant in the original, who shields her mistress from disaster, yet stays close to the main plot, seeing all the inner court's storms."
      }
    ],
    "ambitions": [
      "Rewrite the original ending and survive to the very end",
      "Overthrow the great villain and subvert the story",
      "Win the protagonist's heart and change fate",
      "Retire gracefully and live in seclusion",
      "Uncover the truth of the world and break free from fate",
      "Quietly support the original owner and seek a peaceful end",
      "Turn the villain into an ally and rewrite his ending",
      "Bring down the female lead from her pedestal",
      "Collect scattered plot fragments to see the full picture",
      "Find a way back to the real world"
    ],
    "endings": [
      {
        "condition": "favor<=0",
        "tone": "Protagonist's Nemesis·Dead in Pursuit"
      },
      {
        "condition": "favor<=0",
        "tone": "Betrayed by Former Friend·Poisoned at Banquet"
      },
      {
        "condition": "favor<=0",
        "tone": "Abandoned by Master·Trapped in Lonely City"
      },
      {
        "condition": "favor<=0",
        "tone": "Failure at the Final Step·Death at the Door"
      },
      {
        "condition": "safety<=0",
        "tone": "Erased by Plot Correction"
      },
      {
        "condition": "safety<=0",
        "tone": "Original Plot Resurfaces·Death as Written"
      },
      {
        "condition": "safety<=0",
        "tone": "Inner Demon Backlash·Falling into Madness"
      },
      {
        "condition": "safety<=0",
        "tone": "Peril Strikes·Cut Down by Chaos"
      },
      {
        "condition": "safety<=0",
        "tone": "Lamp Dims·Death in a Strange World"
      },
      {
        "condition": "safety<=0",
        "tone": "Correction's Wrath·Obliteration"
      },
      {
        "condition": "safety<=-1",
        "tone": "Peering Through Fate·Return to Reality"
      },
      {
        "condition": "safety<=-1",
        "tone": "Stealing Fortune·Becoming a New Curse"
      },
      {
        "condition": "safety<=-1",
        "tone": "Usurping the Phoenix Nest·Backlash"
      },
      {
        "condition": "plot>=98",
        "tone": "World Turned Upside Down·Fate Rewritten"
      },
      {
        "condition": "maxTurns & favor>=85 & safety>=70 & plot>=80",
        "tone": "Sworn Friend of Protagonist·Writing a New Legend"
      },
      {
        "condition": "maxTurns & plot>=78 & safety>=54",
        "tone": "Completely Rewriting the Original·Changing the World"
      },
      {
        "condition": "maxTurns & favor>=72 & safety>=60 & plot>=54",
        "tone": "Side by Side with Protagonist·Changing Destiny Together"
      },
      {
        "condition": "maxTurns & favor>=90 & safety>=70",
        "tone": "Mother of the Nation·Crowned with Favor"
      },
      {
        "condition": "maxTurns & favor>=75 & safety>=70",
        "tone": "Winning Protagonist's Heart·A Perfect Ending"
      },
      {
        "condition": "maxTurns & plot>=75 & favor>=75",
        "tone": "Rewriting the Doomed Love·Together Forever"
      },
      {
        "condition": "maxTurns & plot>=62 & safety>=62",
        "tone": "Dodging a Fatal Curse·Opening New Horizons"
      },
      {
        "condition": "maxTurns & has(墨七) & safety>=45",
        "tone": "Love in Adversity·A Lifetime Together"
      },
      {
        "condition": "maxTurns & has(恶毒女配) & favor>=50",
        "tone": "Redemption and Reinvention·A New Persona"
      },
      {
        "condition": "maxTurns & has(反派之女) & safety>=50",
        "tone": "Defying Father's Fate·Family Preserved"
      },
      {
        "condition": "maxTurns & has(陪嫁婢女) & plot>=25",
        "tone": "Maid Rises·A World of Her Own"
      },
      {
        "condition": "maxTurns & favor<=30 & plot>=70",
        "tone": "Defying Heaven Alone·Rebel's Honor"
      },
      {
        "condition": "maxTurns & favor<=30 & safety>=80",
        "tone": "Seeing Through the World·Lamp and Buddha"
      },
      {
        "condition": "maxTurns & favor<=30 & safety>=60",
        "tone": "Strangers to Protagonist·Self-Preservation"
      },
      {
        "condition": "maxTurns & safety>=80 & plot<=30",
        "tone": "Staying in Lane·A Peaceful End"
      },
      {
        "condition": "maxTurns & favor>=60 & safety>=60",
        "tone": "Protected by Kindness·Peaceful Conclusion"
      },
      {
        "condition": "maxTurns & favor>=70",
        "tone": "Protagonist's Close Friend·A Good End"
      },
      {
        "condition": "maxTurns & plot>=70",
        "tone": "Deviating from Original·Forging a New Path"
      },
      {
        "condition": "maxTurns & safety<=20",
        "tone": "Narrow Escape·Surviving Against Odds"
      },
      {
        "condition": "maxTurns & plot<=15",
        "tone": "Going with the Flow·Lost Among Cannon Fodder"
      },
      {
        "condition": "maxTurns & safety>=62",
        "tone": "Careful Steps·A Quiet End"
      },
      {
        "condition": "maxTurns & favor>=55",
        "tone": "Protagonist's Confidant·A Steady Close"
      },
      {
        "condition": "maxTurns & plot>=40",
        "tone": "Ripples into the Sea·A Slight Shift of Fate"
      },
      {
        "condition": "maxTurns",
        "tone": "Peaceful Demise"
      }
    ]
  },
  "spy": {
    "id": "spy",
    "title": "Isle of Shadows",
    "genre": "Espionage",
    "intro": "1940, Shanghai. The concessions are an island, surrounded by the vast occupied territories. You lurk under a false identity, threading the needle between the Japanese puppets, the concessions, and Chongqing, passing intelligence and wrestling with life and death. One wrong word, one revealing glance—and you're a corpse in a ditch. In this sleepless city, survive, and complete your mission.",
    "turnUnit": "Month",
    "attributes": [
      {
        "key": "cover",
        "name": "Cover Identity",
        "bands": [
          "Identity Crumbling",
          "Suspicious Movements",
          "Cover Holding",
          "Flawless"
        ]
      },
      {
        "key": "intel",
        "name": "Intel Merits",
        "bands": [
          "No Deeds Yet",
          "Modest Contributions",
          "Distinguished Service",
          "Paramount Achievements"
        ]
      },
      {
        "key": "trust",
        "name": "Organization Trust",
        "bands": [
          "Suspect as Mole",
          "Under Suspicion",
          "Trust Retained",
          "Right-Hand Confidant"
        ]
      }
    ],
    "openings": [
      {
        "name": "Undercover Operative",
        "prompt": "An agent planted by Chongqing, posing as a Chinese clerk at the Swiss-run Ruichang Trading Company—alone, with no ties above or below."
      },
      {
        "name": "Double Agent",
        "prompt": "A double agent moving between the Wang puppet special services and Chongqing; both sides use you, both sides watch you, and even you are losing track of where your true loyalties lie."
      },
      {
        "name": "Awakened Puppet Official",
        "prompt": "A minor official in the Wang puppet government who, after witnessing the brutal deaths of compatriots, secretly turns against them, wielding connections while walking on thin ice."
      }
    ],
    "ambitions": [
      "Steal critical military intelligence and escape unscathed",
      "Stay undercover to the end and topple a key Wang puppet figure",
      "Protect comrades and dismantle the enemy intelligence apparatus",
      "Unmask the traitor who sold out our comrades",
      "Retire from the game and escort a loved one to safety",
      "Spin a web of intelligence deep within enemy ranks",
      "Turn a high-ranking enemy official to our cause",
      "Safely extract a key figure from danger",
      "Smuggle out one last intelligence report before being exposed",
      "After the war, vanish without a trace and live out your days in obscurity"
    ],
    "endings": [
      {
        "condition": "cover<=0",
        "tone": "Identity Exposed · Calm Martyrdom"
      },
      {
        "condition": "trust<=0",
        "tone": "Suspected as Mole · Eliminated in a Dark Alley"
      },
      {
        "condition": "trust<=0",
        "tone": "Shadow of Betrayal · Poisoned in Tea"
      },
      {
        "condition": "trust<=0",
        "tone": "Treachery Proven · Drowned in the River by Lynch Mob"
      },
      {
        "condition": "trust<=0",
        "tone": "Framed by the Real Traitor · Shot as Scapegoat"
      },
      {
        "condition": "trust<=-1",
        "tone": "Selling Out the Nation · Infamy Eternal"
      },
      {
        "condition": "trust<=-1",
        "tone": "Betraying Friends to Survive · A Debt of Blood"
      },
      {
        "condition": "maxTurns & has(策反成功) & intel>=40",
        "tone": "Successful Defection · Turning the Tide"
      },
      {
        "condition": "intel>=96 & cover>=70",
        "tone": "Unprecedented Triumph · Clean Escape"
      },
      {
        "condition": "intel>=96 & cover<=30",
        "tone": "Legendary Merits · Heroic Sacrifice"
      },
      {
        "condition": "cover>=96",
        "tone": "Deep-Rooted in Enemy Ranks · Unfathomable"
      },
      {
        "condition": "trust>=96",
        "tone": "Top Confidant · Taking Command of Operations"
      },
      {
        "condition": "cover<=6 & intel>=75 & trust>=60",
        "tone": "Success on the Brink · Slipping Away"
      },
      {
        "condition": "cover<=6 & intel>=50 & trust<=25",
        "tone": "Merits and Blame Unclear · Flying South Alone"
      },
      {
        "condition": "cover<=6 & has(双面间谍)",
        "tone": "Distrusted by Both Sides · Fleeing for Life"
      },
      {
        "condition": "cover<=6 & has(觉醒伪职)",
        "tone": "Abandoning the Puppet Regime · Night Escape into Occupied Territory"
      },
      {
        "condition": "cover<=6 & has(阿四)",
        "tone": "Lifeline Severed · Fleeing North a Thousand Miles"
      },
      {
        "condition": "cover<=6 & intel<=20",
        "tone": "No Deeds Achieved · Hasty Flight Beyond the Pass"
      },
      {
        "condition": "cover<=6",
        "tone": "On the Verge of Exposure · Desperate Escape"
      },
      {
        "condition": "maxTurns & has(阿四) & intel>=50",
        "tone": "The Greedy Pawn as a Channel · Using the Enemy's Own Mouth"
      },
      {
        "condition": "maxTurns & has(觉醒伪职) & trust>=65 & intel>=50",
        "tone": "Leaving Darkness for Light · Redeeming Through Deeds"
      },
      {
        "condition": "maxTurns & has(双面间谍) & cover>=72 & trust>=60",
        "tone": "Master of Both Sides · A Quiet Curtain Call"
      },
      {
        "condition": "maxTurns & has(潜伏特工) & intel>=65 & cover>=65",
        "tone": "A Veteran Sleeper · Success and Disappearance"
      },
      {
        "condition": "maxTurns & intel>=80 & cover>=75 & trust>=75",
        "tone": "Unsung Hero on the Hidden Front"
      },
      {
        "condition": "maxTurns & intel>=75 & cover>=70 & trust>=70",
        "tone": "Retiring in Glory · Vanishing Without a Trace"
      },
      {
        "condition": "maxTurns & intel>=70 & trust>=70",
        "tone": "Meritorious Service · Triumphant Return to the Rear"
      },
      {
        "condition": "maxTurns & intel>=70 & cover>=70",
        "tone": "Unbroken in the Shadows · Awaiting Dawn"
      },
      {
        "condition": "maxTurns & cover>=70 & trust>=70 & intel>=30",
        "tone": "Building Merits in Deep Hiding · Biding Time"
      },
      {
        "condition": "maxTurns & cover>=72 & trust>=82",
        "tone": "Untouchable Persona · A Lone Blade in Enemy's Den"
      },
      {
        "condition": "maxTurns & cover>=70 & trust>=70",
        "tone": "Hidden in Plain Sight · Continuing the Mission"
      },
      {
        "condition": "maxTurns & intel>=70 & trust<=30",
        "tone": "Merits Breeding Jealousy · A Lonely Flight for Life"
      },
      {
        "condition": "maxTurns & intel>=70",
        "tone": "Intel Hero · Scarred and Weary"
      },
      {
        "condition": "maxTurns & cover>=70",
        "tone": "Clean Getaway · A Lifetime in Hiding"
      },
      {
        "condition": "maxTurns & trust>=80 & intel>=50",
        "tone": "Loyal Soul · Welcoming the Dawn"
      },
      {
        "condition": "maxTurns & trust>=70",
        "tone": "Loyal Bones Tested · Grieving Lost Comrades"
      },
      {
        "condition": "maxTurns & intel<=20 & cover<=30",
        "tone": "All for Naught · Narrowly Escaping Death"
      },
      {
        "condition": "maxTurns & trust<=25",
        "tone": "Abandoned by All · Slinking Away"
      },
      {
        "condition": "maxTurns & intel<=20",
        "tone": "Wasted Years · No Deeds to Show"
      },
      {
        "condition": "maxTurns & cover<=25",
        "tone": "A Startled Bird · Hasty and Tumultuous End"
      },
      {
        "condition": "maxTurns",
        "tone": "Smoke Scattered · Each to Their Own Fates"
      }
    ]
  },
  "wuxia": {
    "id": "wuxia",
    "title": "Rivers and Lakes, Unbound",
    "genre": "Wuxia",
    "intro": "On a snowy night, you step into the martial world carrying a notched, old blade. Here, there are debts to settle and grudges to avenge, but also a heart as twisted as any ghost; powers beyond compare, yet built on bones. From a nameless nobody to a legendary hero, thirty years on the road—it all depends on where you strike with that blade.",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "gongfu",
        "name": "Martial Arts",
        "bands": [
          "Novice",
          "Skilled",
          "Top-Tier Expert",
          "Supreme Master",
          "Grandmaster of a Generation"
        ]
      },
      {
        "key": "fame",
        "name": "Heroic Reputation",
        "bands": [
          "Notorious Infamy",
          "Mixed Reputation",
          "Well-Regarded",
          "Paragon of Heroism"
        ]
      },
      {
        "key": "life",
        "name": "Vitality",
        "bands": [
          "Clinging to Life",
          "Wounded",
          "Healthy",
          "In Peak Condition"
        ]
      }
    ],
    "openings": [
      {
        "name": "Street Orphan",
        "prompt": "Raised on the streets, cunning and ruthless, your martial skills honed through theft and desperate fights—no sect, no family, with nothing but your wits."
      },
      {
        "name": "Disciple of a Prestigious Sect",
        "prompt": "A direct disciple of a major sect, with a solid foundation and the backing of your masters, yet burdened by heavy rules and sectarian rivalries."
      },
      {
        "name": "Sole Survivor of a Massacre",
        "prompt": "The only survivor of a family slaughtered to the last, carrying a blood feud and a fragmented manual of your ancestral martial arts."
      }
    ],
    "ambitions": [
      "Master legendary martial arts and make a name for yourself",
      "Avenge the bloodbath of your family",
      "Champion justice and settle grudges with honor",
      "Rise to the pinnacle of the martial world and rule over the heroes",
      "Find someone to grow old with and retire from the fray",
      "Collect the long-lost martial arts manuals",
      "Resolve an old, deeply buried grudge from the jianghu",
      "Found your own sect and lead a domain",
      "Uncover the true mastermind behind your family's massacre",
      "Protect a city's people from the chaos of war"
    ],
    "endings": [
      {
        "condition": "life<=0",
        "tone": "Fallen to Blades · Buried in a Desolate Mound"
      },
      {
        "condition": "life<=0",
        "tone": "Slain by a Single Strike · Death at the Sword's Tip"
      },
      {
        "condition": "life<=0",
        "tone": "Ambushed and Overwhelmed · Torn Apart by Many Blades"
      },
      {
        "condition": "life<=0",
        "tone": "Poison Reaching the Heart · Blood from Every Pore"
      },
      {
        "condition": "fame<=0",
        "tone": "Infamous Beyond Redemption · Dying at the Hands of the Martial World"
      },
      {
        "condition": "life<=-1",
        "tone": "Supreme of the Martial World · Grandmaster of an Era"
      },
      {
        "condition": "life<=-1",
        "tone": "Peerless in Skill · Ending as a Tyrant"
      },
      {
        "condition": "life<=-1",
        "tone": "Ascending to Madness · All Meridians Shattered"
      },
      {
        "condition": "life<=-1",
        "tone": "Hidden Injuries Flaring · Collapsing on a Lonely Road"
      },
      {
        "condition": "life<=-1",
        "tone": "Miracle of Fate · Swordsmanship Attaining the Mystic"
      },
      {
        "condition": "maxTurns & fame>=96",
        "tone": "A True Hero · Immortalized Through the Ages"
      },
      {
        "condition": "fame<=6",
        "tone": "Hunted by All · A Fugitive's Life"
      },
      {
        "condition": "life<=4",
        "tone": "Exhausted and Mortally Wounded · Beyond Recovery"
      },
      {
        "condition": "life<=4 & gongfu>=70",
        "tone": "Inner Energy Rampant · Qi Deviation into Sickness"
      },
      {
        "condition": "life<=4 & fame>=85",
        "tone": "Heroic Fame Unmatched · Fading Like a Dying Star"
      },
      {
        "condition": "life<=4 & fame>=70 & gongfu>=80",
        "tone": "Skills Left Unused · Falling Exhausted"
      },
      {
        "condition": "life<=4 & fame>=70 & has(名门弟子)",
        "tone": "Honoring the Sect's Name · Dying at the Bedside"
      },
      {
        "condition": "life<=4 & fame>=70 & has(小石头)",
        "tone": "Legacy Passed On · Closing Eyes with a Smile"
      },
      {
        "condition": "life<=4 & fame>=70 & has(封刀)",
        "tone": "Blade Sheathed in Dust · Death in Bed"
      },
      {
        "condition": "life<=4 & fame>=70",
        "tone": "Heroic Bones to Ashes · Death in Bed"
      },
      {
        "condition": "life<=4 & fame<=20",
        "tone": "Infamy Clinging · No One to Bury the Body"
      },
      {
        "condition": "life<=4 & has(灭门遗孤)",
        "tone": "Consumed by Vengeance · Both Qi and Blood Drained"
      },
      {
        "condition": "life<=4 & has(市井孤儿)",
        "tone": "Alone and Unsupported · Dying in a Street Corner"
      },
      {
        "condition": "maxTurns & has(小石头) & fame>=55",
        "tone": "Martial Legacy Passed On · Successor Awaits"
      },
      {
        "condition": "maxTurns & has(市井孤儿) & gongfu>=85",
        "tone": "Unyielding from the Streets · Roaming Free with a Laugh"
      },
      {
        "condition": "maxTurns & has(名门弟子) & fame>=80",
        "tone": "Sect's Glory Expanded · A Leading Style's Influence"
      },
      {
        "condition": "maxTurns & has(灭门遗孤) & gongfu>=85",
        "tone": "Blood Debt Repaid · Worldly Ties Severed"
      },
      {
        "condition": "maxTurns & gongfu>=80 & fame>=75 & life>=60",
        "tone": "Achieved Fame and Skill · Laughing Across the Jianghu"
      },
      {
        "condition": "maxTurns & fame>=85 & gongfu>=60",
        "tone": "Hero of the People · For Country and Kin"
      },
      {
        "condition": "maxTurns & gongfu>=80 & fame>=70",
        "tone": "Famed Across the Land · A Generation's Hero"
      },
      {
        "condition": "maxTurns & gongfu>=80 & fame<=20",
        "tone": "A Demon Lord of the Age · Villainous Overlord"
      },
      {
        "condition": "maxTurns & gongfu>=75 & life>=60",
        "tone": "Mastery Achieved · Living Out Years in Comfort"
      },
      {
        "condition": "maxTurns & fame>=80 & gongfu>=45",
        "tone": "Heroic Name Far-Reaching · Respected by All"
      },
      {
        "condition": "maxTurns & gongfu>=80 & fame<=30",
        "tone": "Great Skill, Yet Utterly Alone"
      },
      {
        "condition": "maxTurns & gongfu>=75",
        "tone": "A True Artist · Famous in All Directions"
      },
      {
        "condition": "maxTurns & fame>=70",
        "tone": "Half a Life of Chivalry · Reputation Enduring"
      },
      {
        "condition": "maxTurns & gongfu>=45 & life>=50",
        "tone": "Success and Retirement · Retreat to the Mountains"
      },
      {
        "condition": "maxTurns & fame<=25 & gongfu<=30",
        "tone": "Decades of Mediocrity · Fading into Obscurity"
      },
      {
        "condition": "maxTurns & life<=30",
        "tone": "Scarred and Bruised · Barely Surviving"
      },
      {
        "condition": "maxTurns & fame<=25",
        "tone": "Mixed Reputation · Quietly Retiring"
      },
      {
        "condition": "maxTurns & gongfu>=45",
        "tone": "Some Small Fame · Wandering Far and Wide"
      },
      {
        "condition": "maxTurns",
        "tone": "The Jianghu Dream · Returning to a Quiet Life"
      }
    ]
  },
  "sanguo": {
    "id": "sanguo",
    "title": "The Strategist of Chaos",
    "genre": "Three Kingdoms",
    "intro": "The Han dynasty crumbles; the Yellow Turbans are not yet quelled when new warlords rise. He who holds the emperor commands the lords, and each who rules a province harbors his own ambitions. The Central Plains blaze with endless war. You are a mere strategist, your heart holding grand schemes to unify the realm, your hands holding only a brush and a tongue. Choose your lord, offer counsel, wage war, weigh the balance—through thirty years of shifting winds, see how you carve a path for others, and for yourself, amid the glint of blades.",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "wit",
        "name": "Cunning",
        "bands": [
          "Armchair General",
          "Rising Talent",
          "Master Strategist",
          "Peerless Planner",
          "Heaven-Tier Genius"
        ]
      },
      {
        "key": "repute",
        "name": "Reputation",
        "bands": [
          "Disgraced",
          "Mixed Repute",
          "Renowned in the Region",
          "Celebrated Scholar of the Realm"
        ]
      },
      {
        "key": "trust",
        "name": "Lord's Trust",
        "bands": [
          "Suspected and Rebuked",
          "Drifting Apart",
          "Trusted Advisor",
          "Puppet in His Hands"
        ]
      }
    ],
    "openings": [
      {
        "name": "Humble Wandering Scholar",
        "prompt": "Born of lowly means, you have traveled far to learn from masters, your mind teeming with strategies but lacking a path to power. You seek a wise lord to realize your ambitions."
      },
      {
        "name": "Aristocratic Scion",
        "prompt": "Descendant of a prestigious clan, raised on the arts of governance, you bear the burden of your family's rise and fall. Every step you take reflects the honor of your house."
      },
      {
        "name": "Surrendered General's Strategist",
        "prompt": "Your former lord has fallen, and you bring your battered remnants and cunning schemes to a new master. Carrying the stigma of surrender, you must wash away suspicion with deeds."
      }
    ],
    "ambitions": [
      "Aid a wise lord to unify the realm",
      "Carve a name in history as a matchless strategist",
      "Restore the Han dynasty and re-establish court authority",
      "Retire in success to safeguard your family",
      "Rise to the pinnacle of power, overshadowing the court",
      "Devise one grand plan that decides the fate of the realm",
      "Forge an alliance between two factions to resist a mighty foe",
      "Open a path of advancement for humble scholars",
      "Capture or persuade a renowned general to switch sides",
      "Author a treatise on warfare and mentor many disciples"
    ],
    "endings": [
      {
        "condition": "trust<=-1",
        "tone": "Served the Wrong Lord - Death of Clan"
      },
      {
        "condition": "trust<=-1",
        "tone": "Merits Too Great - Slain in Prison"
      },
      {
        "condition": "maxTurns & has(名动天下) & repute>=50",
        "tone": "One Word Decides All - Fame in the Realm"
      },
      {
        "condition": "trust<=0",
        "tone": "Suspected and Condemned - Death in Cell"
      },
      {
        "condition": "repute<=6 & trust<=18",
        "tone": "Ruined Reputation - Clan Executed"
      },
      {
        "condition": "maxTurns & has(霸业) & wit>=96 & trust>=70 & has(寒门游学士子)",
        "tone": "From Humble Origins - Commoner Minister"
      },
      {
        "condition": "maxTurns & has(霸业) & wit>=96 & trust>=70 & has(世家子弟)",
        "tone": "Aristocratic Mastery - Eternal Glory of the House"
      },
      {
        "condition": "maxTurns & has(霸业) & wit>=96 & trust>=70 & has(降将谋臣)",
        "tone": "The Turned Minister Governs the State - All Doubts Cleared"
      },
      {
        "condition": "maxTurns & has(霸业) & wit>=96 & trust>=70",
        "tone": "Heaven-Tier Genius - Everlasting Premier"
      },
      {
        "condition": "maxTurns & wit>=96",
        "tone": "Peerless Planner - Solitary by Wit"
      },
      {
        "condition": "repute<=6",
        "tone": "Ruin and Exile - Fleeing for Life"
      },
      {
        "condition": "trust<=6",
        "tone": "King and Minister at Odds - Silent Departure"
      },
      {
        "condition": "maxTurns & has(书童) & wit>=85",
        "tone": "Young Aide Risen - Legacy Continues"
      },
      {
        "condition": "maxTurns & has(寒门游学士子) & wit>=85",
        "tone": "Humble Scholar Elevated - Ambitions Fulfilled"
      },
      {
        "condition": "maxTurns & has(世家子弟) & repute>=88",
        "tone": "Aristocrat Aids State - House Prestige Soars"
      },
      {
        "condition": "maxTurns & has(降将谋臣) & trust>=68",
        "tone": "Turned Minister Merits Glory - Suspicions Melted"
      },
      {
        "condition": "maxTurns & wit>=80 & trust>=68 & repute>=60",
        "tone": "Aiding Great Enterprise - Founding Minister"
      },
      {
        "condition": "maxTurns & repute>=85 & wit>=60",
        "tone": "Restoring Han - Lone Loyalty in History"
      },
      {
        "condition": "maxTurns & wit>=80 & trust>=62",
        "tone": "Master Planner - Trusted Pillar of State"
      },
      {
        "condition": "maxTurns & wit>=80 & repute<=20",
        "tone": "Scheming Tyrant - Lone Descent into Darkness"
      },
      {
        "condition": "maxTurns & trust>=80 & wit>=45",
        "tone": "Unbreakable Bond with Lord - Graceful Old Age"
      },
      {
        "condition": "maxTurns & repute>=80 & wit>=45",
        "tone": "Famous Across the Land - Model of Scholars"
      },
      {
        "condition": "maxTurns & wit>=80 & trust<=30",
        "tone": "High Wisdom Breeds Suspicion - Ambitions Stifled"
      },
      {
        "condition": "maxTurns & wit>=75 & repute>=45",
        "tone": "A Strategist for the Ages - Noticed by Warlords"
      },
      {
        "condition": "maxTurns & repute>=96",
        "tone": "Celebrated Scholar - Revered for Millennia"
      },
      {
        "condition": "maxTurns & repute>=70",
        "tone": "Pure Name Endures - Remembered by Scholars"
      },
      {
        "condition": "maxTurns & trust>=62 & wit>=40",
        "tone": "Success and Retreat - Escaping Calamity"
      },
      {
        "condition": "maxTurns & repute<=25 & wit<=30",
        "tone": "Mediocre Half-Life - Fading into the Crowd"
      },
      {
        "condition": "maxTurns & trust<=30",
        "tone": "Drifting Apart - Reluctant to Stay"
      },
      {
        "condition": "maxTurns & repute<=25",
        "tone": "Mixed Repute - Quietly Retiring"
      },
      {
        "condition": "maxTurns & wit>=45",
        "tone": "Mild Repute as Strategist - Drifting Through the Strife"
      },
      {
        "condition": "maxTurns",
        "tone": "A Dream in Chaos - Returned to Dust"
      }
    ]
  },
  "wasteland": {
    "id": "wasteland",
    "title": "Survival in the Wasteland",
    "genre": "Post-Apocalyptic",
    "intro": "In the year the unknown virus erupted, cities fell amidst screams. The promised military rescue never came, and one official safe zone after another collapsed, turning into new graveyards. Ruins became the entirety of the world. The infected roam by day, but emerge at night. Among survivors, there is both camaraderie and mutual predation. For three years, you must survive in this broken land—and from the rubble, rebuild a haven of order for the living.",
    "turnUnit": "Month",
    "attributes": [
      {
        "key": "hp",
        "name": "Health",
        "bands": [
          "Near Death",
          "Injured",
          "Healthy",
          "Robust"
        ]
      },
      {
        "key": "sanity",
        "name": "Sanity",
        "bands": [
          "On the Brink",
          "Shaken",
          "Clear",
          "Unwavering"
        ]
      },
      {
        "key": "supplies",
        "name": "Supplies",
        "bands": [
          "Depleted",
          "Scarce",
          "Adequate",
          "Ample"
        ]
      }
    ],
    "openings": [
      {
        "name": "Convenience Store Clerk",
        "prompt": "Trapped during a night shift, familiar with the store's supplies and the surrounding streets."
      },
      {
        "name": "Retired Military Medic",
        "prompt": "Skilled in first aid and weaponry, but with an old wound in the left leg, expends stamina faster."
      },
      {
        "name": "High School Student",
        "prompt": "Agile and fast, but lacking survival experience and prone to acting on impulse."
      }
    ],
    "ambitions": [
      "Survive long-term in the apocalypse",
      "Scavenge supplies to build a secure haven",
      "Find and protect other survivors",
      "Uncover the truth behind the virus outbreak",
      "Stockpile supplies and travel far to find a pristine land",
      "Develop a cure to halt the virus",
      "Establish your own order and power in the wasteland",
      "Seek justice for your brutally slain family",
      "Uphold your humanity amidst the apocalypse",
      "Assemble a survivor team bound by life-and-death loyalty"
    ],
    "endings": [
      {
        "condition": "hp<=0 & has(据点)",
        "tone": "Died Defending the Haven - Nothing Abandoned"
      },
      {
        "condition": "hp<=0",
        "tone": "Died of Exhaustion"
      },
      {
        "condition": "hp<=0",
        "tone": "Starved on the Streets"
      },
      {
        "condition": "hp<=0",
        "tone": "Died of Thirst on the Road"
      },
      {
        "condition": "hp<=0",
        "tone": "Succumbed to Illness Without Aid"
      },
      {
        "condition": "hp<=0",
        "tone": "Poisoned to Death"
      },
      {
        "condition": "hp<=0",
        "tone": "Bled Out"
      },
      {
        "condition": "sanity<=0",
        "tone": "Lost to Madness - Vanished into the Ruins"
      },
      {
        "condition": "sanity<=-1",
        "tone": "Gave in to Savagery - Resorted to Cannibalism"
      },
      {
        "condition": "sanity<=-1",
        "tone": "Abandoned All - Now a Wandering Ghost"
      },
      {
        "condition": "sanity<=-1",
        "tone": "A Flicker of Light in the Wasteland - Sacrificed All"
      },
      {
        "condition": "maxTurns & hp>=54 & sanity>=78 & supplies>=70",
        "tone": "Wasteland King - Restored Order"
      },
      {
        "condition": "maxTurns & hp>=49 & sanity>=70 & supplies>=63",
        "tone": "Regal Return - Nearly Unscathed"
      },
      {
        "condition": "maxTurns & hp>=44 & sanity>=62 & supplies>=56",
        "tone": "Standing Steadfast - Rebuilding Possible"
      },
      {
        "condition": "maxTurns & hp>=44 & supplies>=62",
        "tone": "A Survivor Laden with Supplies"
      },
      {
        "condition": "maxTurns & hp>=50 & sanity>=66",
        "tone": "Whole in Body and Mind - Dawn on the Horizon"
      },
      {
        "condition": "maxTurns & supplies>=66 & hp>=42 & sanity>=50",
        "tone": "Rebuilt the Haven - Civilization Rekindled"
      },
      {
        "condition": "maxTurns & supplies>=66 & sanity>=54",
        "tone": "Master of the Haven - After the Storm Comes Clear Skies"
      },
      {
        "condition": "maxTurns & hp>=48 & supplies>=56",
        "tone": "A Survivor with Firm Footing"
      },
      {
        "condition": "maxTurns & has(阿黄) & sanity>=45",
        "tone": "Never Forsaken - Companions in the Wilderness"
      },
      {
        "condition": "maxTurns & has(店员)",
        "tone": "An Ordinary Soul, Unyielding - Endured the Apocalypse"
      },
      {
        "condition": "maxTurns & has(军医) & sanity>=55",
        "tone": "Healer of the Wasteland - A Beacon of Hope"
      },
      {
        "condition": "maxTurns & has(高中生) & supplies>=55",
        "tone": "Youth Grown Strong - A New Bloom in the Wastes"
      },
      {
        "condition": "maxTurns & hp<=20 & sanity<=20",
        "tone": "Barely Breathing - A Miraculous Survival"
      },
      {
        "condition": "maxTurns & sanity<=20 & supplies>=60",
        "tone": "A Walking Corpse - Alive Yet Dead"
      },
      {
        "condition": "maxTurns & sanity<=20 & supplies<=20",
        "tone": "Exhausted in Body and Mind - A Pyrrhic Victory for Life"
      },
      {
        "condition": "maxTurns & sanity<=20",
        "tone": "Survived, but Mentally Broken"
      },
      {
        "condition": "maxTurns & hp<=20",
        "tone": "At the End of Reserves - Barely Holding On"
      },
      {
        "condition": "maxTurns & supplies<=15",
        "tone": "Edge of Starvation - Just Managed to Survive"
      },
      {
        "condition": "maxTurns & sanity>=80",
        "tone": "A Survivor with a Heart of Stone"
      },
      {
        "condition": "maxTurns & hp>=56",
        "tone": "A Survivor of Iron and Bone"
      },
      {
        "condition": "maxTurns & supplies>=70 & hp<=55",
        "tone": "Ample Stores, Escaped with Wounds"
      },
      {
        "condition": "maxTurns & hp>=52",
        "tone": "Body Still Strong - Standing Firm"
      },
      {
        "condition": "maxTurns & sanity>=60",
        "tone": "Sound Mind - Held Out to the End"
      },
      {
        "condition": "maxTurns & hp>=40",
        "tone": "Scarred and Bruised - Endured to This Day"
      },
      {
        "condition": "maxTurns",
        "tone": "Outlasted the Apocalypse"
      }
    ]
  },
  "officialdom": {
    "id": "officialdom",
    "title": "The Turbulent Court",
    "genre": "Court & Politics",
    "intro": "After passing the imperial examinations, you step into the grand court of this glorious dynasty as a newly appointed scholar-official. From a seventh-rank county magistrate to a Grand Secretary, the road ahead is fraught with factional strife, performance reviews, natural disasters, imperial authority, and the treacherous currents of human hearts. A single misstep could cost you your post, your family, or even your life. In this sea of officialdom, survive—and become the person you aspire to be.",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "name",
        "name": "Reputation",
        "bands": [
          "Infamous",
          "Mixed Reputation",
          "Upright & Honest",
          "Praised by the People"
        ]
      },
      {
        "key": "favor",
        "name": "Imperial Favor",
        "bands": [
          "The Emperor's Wrath",
          "Favor Waning",
          "Favor Still Warm",
          "Beloved by the Throne"
        ]
      },
      {
        "key": "power",
        "name": "Influence",
        "bands": [
          "Isolated & Helpless",
          "Shallow Foundations",
          "Growing Following",
          "Dominating the Court"
        ]
      }
    ],
    "openings": [
      {
        "name": "Humble Scholar",
        "prompt": "Born of poverty and hard study, with no connections, you carry a noble spirit but shallow roots—relying solely on yourself."
      },
      {
        "name": "Aristocratic Scion",
        "prompt": "A descendant of a prestigious family, you possess deep networks and a privileged start, yet bear the heavy burden of your house and faction."
      },
      {
        "name": "Adopted Son of the Inner Court",
        "prompt": "Risen through the favor of the Chief Eunuch of the Directorate of Ceremonial, you easily gain imperial favor and connections, yet are despised by the pure-minded literati."
      }
    ],
    "ambitions": [
      "Rise to the pinnacle of power and enter the Grand Secretariat",
      "Champion the people's cause and leave a lasting name in history",
      "Accumulate vast wealth and live in luxury",
      "Topple corrupt officials and purify the court",
      "Retire gracefully after achieving merit",
      "Wield power over the realm, second only to the emperor",
      "Secure eternal honor for your family for generations",
      "Avenge your wronged mentor and clear their name",
      "Implement new policies and eradicate long-standing abuses",
      "Stay above factional strife and preserve yourself wisely"
    ],
    "endings": [
      {
        "condition": "favor<=-1",
        "tone": "Literary Inquisition: Dies in Prison"
      },
      {
        "condition": "favor<=-1",
        "tone": "Factional Fall: Entire Family Executed"
      },
      {
        "condition": "maxTurns & has(骤擢入阁) & power>=60",
        "tone": "Beloved by the Throne: Sudden Rise to the Grand Secretariat"
      },
      {
        "condition": "favor<=-1",
        "tone": "Sudden Prominence Invites Jealousy: Poisoned to Death"
      },
      {
        "condition": "favor<=-1",
        "tone": "Lost the Gambit of Imperial Succession: Whole House Buried"
      },
      {
        "condition": "favor<=-1",
        "tone": "Power's Backlash: Death of Self and Kin"
      },
      {
        "condition": "favor<=-1",
        "tone": "Defied the Throne and Slept: Blood Spilled on the Steps"
      },
      {
        "condition": "favor<=0",
        "tone": "House Searched and Execution Ordered"
      },
      {
        "condition": "favor<=0",
        "tone": "Tortured in the Imperial Prison: Died in Chains"
      },
      {
        "condition": "favor<=0",
        "tone": "Family Exiled: Bones Withered in the Foul Swamps"
      },
      {
        "condition": "favor<=0",
        "tone": "Sent a Silken Cord to End Your Life: Redemption with a Whole Corpse"
      },
      {
        "condition": "power>=96 & favor<=25",
        "tone": "Merit Overshadows the Sovereign: Ordered to Die in Prison"
      },
      {
        "condition": "maxTurns & name>=96 & power>=70",
        "tone": "Commander and Minister: Name Eternal in History"
      },
      {
        "condition": "maxTurns & name>=96 & has(寒门进士)",
        "tone": "Upright Scholar from Humble Origins: A Pure and Loyal Minister"
      },
      {
        "condition": "maxTurns & name>=96 & has(世家子弟)",
        "tone": "Noble Progeny Capable Official: Blessings to the People"
      },
      {
        "condition": "maxTurns & name>=96 & has(内廷养子)",
        "tone": "Washing Away the Taint: A Commoner's Blue Sky"
      },
      {
        "condition": "maxTurns & name>=96 & power>=55",
        "tone": "Clear Reputation & Power: A Capable Official with the People's Love"
      },
      {
        "condition": "maxTurns & name>=96 & favor<=20",
        "tone": "A Disfavored Judge: The People's Hearts Alone Remain"
      },
      {
        "condition": "maxTurns & name>=96",
        "tone": "Praised by All: A Reborn Judge"
      },
      {
        "condition": "maxTurns & power>=96",
        "tone": "Dominating the Court: A Hand That Covers the Sky"
      },
      {
        "condition": "maxTurns & favor>=96",
        "tone": "Beloved by the Throne: Unprecedented Favor"
      },
      {
        "condition": "name<=4 & favor<=12 & turn>=18",
        "tone": "Disgraced and Abandoned: Cast into Prison"
      },
      {
        "condition": "name<=4 & power>=60 & turn>=18",
        "tone": "Corrupt Official's Downfall: The Wall Crumbles at Everyone's Push"
      },
      {
        "condition": "name<=4 & has(内廷养子) & turn>=18",
        "tone": "Eunuch Faction Loses Patron: Purged and Stripped of Rank"
      },
      {
        "condition": "name<=4 & has(世家子弟) & turn>=18",
        "tone": "Bringing Shame to the Family: Stripped and Returned to the Clan"
      },
      {
        "condition": "name<=4 & has(寒门进士) & turn>=18",
        "tone": "Humble Scholar's Fall: Somber Return to Hometown"
      },
      {
        "condition": "name<=4 & favor>=60 & turn>=18",
        "tone": "Flattering the Sovereign, Losing Scholars: Ruin and Shame"
      },
      {
        "condition": "name<=4 & turn>=18",
        "tone": "Reputation Ruined: Stripped of Rank and Made a Commoner"
      },
      {
        "condition": "maxTurns & has(门生) & name>=46",
        "tone": "Disciples Abound: The Pure Stream Endures"
      },
      {
        "condition": "maxTurns & has(寒门进士) & name>=50",
        "tone": "A Lone Scholar from Humble Origins: Pure Name Eternal"
      },
      {
        "condition": "maxTurns & has(世家子弟) & power>=50",
        "tone": "Rise and Fall of a Noble House: The Family's Prestige Grows"
      },
      {
        "condition": "maxTurns & has(内廷养子) & favor>=55",
        "tone": "Inner Court's Favor: Dominating for a Time"
      },
      {
        "condition": "maxTurns & name>=85 & favor>=60 & power>=60",
        "tone": "Wise Minister and Sage: Honored in the Imperial Ancestral Temple"
      },
      {
        "condition": "maxTurns & name>=75 & favor>=75 & power>=75",
        "tone": "Elder of Three Reigns: A Generation's Wise Prime Minister"
      },
      {
        "condition": "maxTurns & favor>=70 & power>=70",
        "tone": "Power and Favor Both Complete: A Pillar of the State"
      },
      {
        "condition": "maxTurns & name>=70 & power>=70",
        "tone": "Pure Reputation and Power: Both Attained"
      },
      {
        "condition": "maxTurns & name>=70 & favor>=70",
        "tone": "Imperial Tutor and Pure Scholar: Retiring to a Life of Ease"
      },
      {
        "condition": "maxTurns & name>=80 & power<=20",
        "tone": "Carrying One's Own Coffin: A Straightforward Minister Eternal in Bone"
      },
      {
        "condition": "maxTurns & power>=80 & favor<=20",
        "tone": "A Powerful Minister's End: The Bow Is Hung When the Birds Are Gone"
      },
      {
        "condition": "maxTurns & favor>=80 & name<=20",
        "tone": "A Favorite Flatterer: Cursed After Death"
      },
      {
        "condition": "maxTurns & power>=70 & name<=30",
        "tone": "The Era's Corrupt Power: Name Renowned in Infamy"
      },
      {
        "condition": "maxTurns & favor>=70 & name<=30",
        "tone": "A Crafty Sycophant: Glory for a Time"
      },
      {
        "condition": "maxTurns & name>=75 & power<=30",
        "tone": "A Righteous Official with Sleeves Full of Wind"
      },
      {
        "condition": "maxTurns & favor<=25 & power<=25",
        "tone": "Drifting in the Sea of Officialdom: A Gloomy Return Home"
      },
      {
        "condition": "maxTurns & name>=60",
        "tone": "An Honest Bureaucrat's Good End: Respected by Hometown Kin"
      },
      {
        "condition": "maxTurns & power>=60",
        "tone": "A Mature Statesman: Disciples Fill the Court"
      },
      {
        "condition": "maxTurns & favor>=60",
        "tone": "Unfading Grace and Honor: Enjoying Veneration in Ease"
      },
      {
        "condition": "maxTurns & name<=25",
        "tone": "Besmirched Name: Retiring in Adversity"
      },
      {
        "condition": "maxTurns & favor<=25",
        "tone": "Imperial Heart Distant: Returning Coldly to Hometown"
      },
      {
        "condition": "maxTurns",
        "tone": "Retired and Returned Home: A Life of Quiet Mediocrity"
      }
    ]
  },
  "scifi": {
    "id": "scifi",
    "title": "Beyond the Stars",
    "genre": "Science Fiction",
    "intro": "Earth is but a dying ember. You set course aboard the generation colony ship 'Ember' toward an unknown star system thirty light-years away. Within the hold, tens of thousands of humans sleep in cryo; outside lies the primeval darkness and the unknown. Supplies, malfunctions, human hearts, anomalies—each year tests whether the ember of humanity can be rekindled beyond the stars.",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "tech",
        "name": "Technology",
        "bands": [
          "Stretched Thin",
          "Steady Progress",
          "Cutting-Edge",
          "On the Verge of Breakthrough",
          "Technological Singularity"
        ]
      },
      {
        "key": "integrity",
        "name": "Hull Integrity",
        "bands": [
          "On the Brink of Dissolution",
          "Riddled with Holes",
          "Structurally Sound",
          "Indestructible"
        ]
      },
      {
        "key": "colony",
        "name": "Civilization's Ember",
        "bands": [
          "About to Go Out",
          "Restless Hearts",
          "Settled & Secure",
          "Thriving"
        ]
      }
    ],
    "openings": [
      {
        "name": "Colony Captain",
        "prompt": "The supreme commander shouldering the lives of tens of thousands, whose word is law—yet also reviled by many and isolated at the height of power."
      },
      {
        "name": "Chief Scientist",
        "prompt": "The core of all cutting-edge technology aboard, yet constantly torn between survival and ethics."
      },
      {
        "name": "Acting Captain on Crisis",
        "prompt": "The original captain suddenly perished, and you were roused from cryosleep by emergency protocols to assume command—an unprepared and unstable successor."
      }
    ],
    "ambitions": [
      "Find a habitable planet and rebuild home",
      "Ensure the entire crew arrives alive",
      "Unravel the secrets of the ship and the star map",
      "Lay the foundation for a new human civilization",
      "Discover the truth of Earth's silence",
      "Achieve first contact with an unknown civilization",
      "Defuse the deadly crisis threatening the ship",
      "Awaken the ship's slumbering superintelligence",
      "Find another surviving human group in the star sea",
      "Avert a destined catastrophe for civilization"
    ],
    "endings": [
      {
        "condition": "integrity<=0",
        "tone": "Ship Disintegrates: All Hands Lost"
      },
      {
        "condition": "colony<=0",
        "tone": "Ember Extinguished: Civilization Ends"
      },
      {
        "condition": "colony<=-1",
        "tone": "Forced Purge for Survival: A Blood Debt Cast into the Void"
      },
      {
        "condition": "colony<=-1",
        "tone": "Slaughter of the Natives: Foundations Built on Sin"
      },
      {
        "condition": "colony<=-1",
        "tone": "Symbiosis in the Star Sea: A Civilization Forever"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Repair Mishap: Consumed by Plasma"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Shields Breached: Hull Pierced and Sunk"
      },
      {
        "condition": "colony<=-1",
        "tone": "Landing Party Lost: Morale Shattered"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Luring the Enemy Backfired: Ship and Crew Destroyed"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Sealing Failed: Core Meltdown"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Orbit Lost: Plunged into the Gravitational Well"
      },
      {
        "condition": "integrity<=-1",
        "tone": "Plasma Overload: Electrical Systems Incinerated"
      },
      {
        "condition": "tech>=87 & colony>=58",
        "tone": "Technological Singularity: New Life in the Star Sea"
      },
      {
        "condition": "tech>=85 & integrity>=50",
        "tone": "Breakthrough at the Singularity: Transcending the Body"
      },
      {
        "condition": "tech>=87",
        "tone": "Ascending to the Singularity: Humanity Erased"
      },
      {
        "condition": "colony>=96 & has(抵近) & has(星娃)",
        "tone": "Hearts United: The Ship Rises to Carry the Flame"
      },
      {
        "condition": "colony>=96 & has(抵近) & has(殖民舰长)",
        "tone": "All Hearts as One: Worthy of the Multitude"
      },
      {
        "condition": "colony>=96 & has(抵近) & tech<=25",
        "tone": "Nothing Else but Will: Driven by Pure Heart"
      },
      {
        "condition": "colony>=96 & has(抵近) & integrity>=70",
        "tone": "United Fortress: A Home in New Silks"
      },
      {
        "condition": "colony>=96 & has(抵近)",
        "tone": "One Heart Amid Thousands: Rebirth of Civilization"
      },
      {
        "condition": "maxTurns & colony>=96 & !has(抵近)",
        "tone": "Ember Never Extinguished: Haven't Reached the Shore"
      },
      {
        "condition": "colony<=6",
        "tone": "Hearts Lost: A Deadly Silent Ship"
      },
      {
        "condition": "integrity<=6",
        "tone": "Barely Surviving: A Drifting Coffin"
      },
      {
        "condition": "maxTurns & colony>=88 & tech>=60",
        "tone": "Prosperity Through the Ages: A Star-Sea Empire"
      },
      {
        "condition": "maxTurns & tech>=72 & colony>=64 & integrity>=44",
        "tone": "Arrived at a New World: An Epoch Begins"
      },
      {
        "condition": "maxTurns & tech>=80 & colony>=70",
        "tone": "Flourishing Technology: Foundations for a New Home"
      },
      {
        "condition": "maxTurns & colony>=66 & integrity>=42",
        "tone": "Arrived Safely: The Flame Passes On"
      },
      {
        "condition": "maxTurns & tech>=68 & integrity>=42",
        "tone": "Reaching Shore by Technology: Rebuilding Is Possible"
      },
      {
        "condition": "maxTurns & has(星娃) & colony>=45",
        "tone": "New Ember Born: The Star-Sea Descendants"
      },
      {
        "condition": "maxTurns & has(殖民舰长) & colony>=55",
        "tone": "A Captain's Fate: Trust Honored"
      },
      {
        "condition": "maxTurns & has(首席科学家) & tech>=60",
        "tone": "The Chief's Dream: Founding a World on Technology"
      },
      {
        "condition": "maxTurns & has(代理舰长) & integrity>=18",
        "tone": "Risen to the Crisis: Turned the Tide"
      },
      {
        "condition": "maxTurns & tech>=85 & colony<=20",
        "tone": "The Machine Rises: Humanity Erased"
      },
      {
        "condition": "maxTurns & tech>=80 & colony<=30",
        "tone": "Technology Sky-High: People Scarce"
      },
      {
        "condition": "maxTurns & colony>=70",
        "tone": "Hearts United: At Last a New Star Visited"
      },
      {
        "condition": "maxTurns & tech>=75",
        "tone": "Founded on Technology: Crossed the Star Sea with Peril"
      },
      {
        "condition": "maxTurns & integrity>=70",
        "tone": "Sturdy Ship Reaches Shore: Much to Be Done"
      },
      {
        "condition": "maxTurns & tech<=25 & colony<=30",
        "tone": "A Lost Voyage: Barely Surviving"
      },
      {
        "condition": "maxTurns & colony<=25",
        "tone": "Hearts Scattered: A Grim Arrival"
      },
      {
        "condition": "maxTurns & integrity<=30 & colony>=48",
        "tone": "Crippled Ship Bearing Many: Ember Flees South"
      },
      {
        "condition": "maxTurns & integrity<=30 & colony<=35",
        "tone": "Wrecked Ship Adrift: A Desolate Shore"
      },
      {
        "condition": "maxTurns & integrity<=30 & tech>=64",
        "tone": "Wreck Keeps the Technology: A Spark That May Kindle"
      },
      {
        "condition": "maxTurns & integrity<=30",
        "tone": "Broken Arrival: Rebirth Among Ruins"
      },
      {
        "condition": "maxTurns & tech>=45",
        "tone": "Steady Course: Reaching the End"
      },
      {
        "condition": "maxTurns",
        "tone": "A Long Voyage: Return to the Stars"
      }
    ]
  },
  "voyage": {
    "id": "voyage",
    "title": "Raging Seas, Fierce Blades",
    "genre": "Maritime Adventure",
    "intro": "Salt-laden wind whips at your face as you stand on the deck of your first ship, endless blue stretching to the horizon. This is the age of sail, where the deep ocean hides routes uncharted, treasures piled high with gold, and storms and battles that swallow entire fleets. Thirty years of furious sea life—will your sail carry you to a throne, or to the belly of a fish?",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "ship",
        "name": "Fleet Strength",
        "bands": [
          "Leaky Wreck",
          "Aged Sailing Ship",
          "Well-Armed Warship",
          "Mighty Flagship",
          "Invincible Armada"
        ]
      },
      {
        "key": "wealth",
        "name": "Fortunes",
        "bands": [
          "Penniless",
          "Modest Savings",
          "Loaded with Gold",
          "Richer Than Nations"
        ]
      },
      {
        "key": "crew",
        "name": "Crew Loyalty",
        "bands": [
          "Mutiny and Abandonment",
          "Restless, Wavering Allegiance",
          "United as One",
          "Adored and Followed"
        ]
      }
    ],
    "openings": [
      {
        "name": "Son of a Bankrupt Merchant",
        "prompt": "The fallen scion of a maritime trading family, whose fortune sank in a shipwreck, leaving only an old vessel, a debt-ridden past, and a head full of routes and market knowledge."
      },
      {
        "name": "Mutiny Sailor",
        "prompt": "A helmsman who seized a ship after enduring oppression, with unmatched sailing skills and a loyal band of brothers, yet branded by the law and unwelcome in any port."
      },
      {
        "name": "Impoverished Noble Navigator",
        "prompt": "A landless noble harboring a fragmentary ancestral sea chart and an obsession with unknown continents, selling his family crest to secure passage on a distant voyage."
      }
    ],
    "ambitions": [
      "Find the legendary golden treasure",
      "Build a trading empire across the seven seas",
      "Discover a long-lost sea route",
      "Take revenge on the enemy who ruined my family",
      "Be appointed Admiral of the Navy and return home in glory",
      "Chart a complete map of the seven seas",
      "Command a fleet that strikes fear into all nations",
      "Unravel the mystery of sea demons and ancient navigators",
      "Establish my own free port on a deserted island",
      "Clear my family's unjust name"
    ],
    "endings": [
      {
        "condition": "ship<=0",
        "tone": "Ship Wrecked, Drowned in the Depths"
      },
      {
        "condition": "ship<=0",
        "tone": "Ran Aground, Swallowed by Dark Waters"
      },
      {
        "condition": "ship<=0",
        "tone": "Fire and Gunpowder, Engulfed in Flames"
      },
      {
        "condition": "ship<=0",
        "tone": "Grievously Wounded, Mast Broken, Rudder Lost"
      },
      {
        "condition": "ship<=0",
        "tone": "Braving the Storm, Wrecked and Sunk"
      },
      {
        "condition": "ship<=0",
        "tone": "Trapped on a Deserted Isle, Buried in the Wild"
      },
      {
        "condition": "crew<=0",
        "tone": "Betrayed by All, Lost to Internal Strife"
      },
      {
        "condition": "crew<=-1",
        "tone": "Slaughtered the Island for Gold, Evil Beyond Redemption"
      },
      {
        "condition": "crew<=-1",
        "tone": "Abandoned Brotherhood for Greed, Left to Rot"
      },
      {
        "condition": "maxTurns & has(自由之王) & crew>=50",
        "tone": "Lord of the Savage Seas, King of Freedom"
      },
      {
        "condition": "maxTurns & ship>=88 & wealth>=80 & crew>=70",
        "tone": "Sovereign of the Waves, Ruler of Seven Seas"
      },
      {
        "condition": "maxTurns & wealth>=80 & crew>=70",
        "tone": "Maritime Tycoon, Richest Across the Seas"
      },
      {
        "condition": "maxTurns & has(独眼) & crew>=50",
        "tone": "Comrades Through Thick and Thin, Shipmates to the End"
      },
      {
        "condition": "maxTurns & has(商人之子) & wealth>=88",
        "tone": "Family Rebuilt, Legacy of Maritime Trade"
      },
      {
        "condition": "maxTurns & has(哗变水手) & ship>=60",
        "tone": "From Outlaw to Sea Lord, Self-Made Overlord"
      },
      {
        "condition": "maxTurns & has(贵族航海家) & crew>=55",
        "tone": "Dreams of Distant Voyage, At Last Fulfilled"
      },
      {
        "condition": "maxTurns & ship>=85 & crew>=65",
        "tone": "Appointed Admiral, Royal Banner Raised"
      },
      {
        "condition": "maxTurns & ship>=80 & wealth>=70",
        "tone": "Fierce Overlord of the Seas, Commands the Seven Oceans"
      },
      {
        "condition": "maxTurns & wealth>=85 & ship>=45",
        "tone": "Richer Than Kings, Mountains of Gold and Silver"
      },
      {
        "condition": "maxTurns & crew>=85 & ship>=50",
        "tone": "United Hearts, Brothers on the Same Deck"
      },
      {
        "condition": "maxTurns & ship>=85 & crew<=25",
        "tone": "Alone at the Helm, Sovereign of the Betrayed"
      },
      {
        "condition": "maxTurns & wealth>=80 & crew<=25",
        "tone": "Wealthy Beyond Measure, Guarding Gold Alone"
      },
      {
        "condition": "maxTurns & ship>=80 & crew<=35",
        "tone": "Iron Flagship, Tyrant of Solitary Seas"
      },
      {
        "condition": "maxTurns & ship>=75 & wealth>=50",
        "tone": "Mighty in One Corner, Master of a Own Domain"
      },
      {
        "condition": "maxTurns & crew>=80",
        "tone": "United in Heart, Loyalty Shakes the Heavens"
      },
      {
        "condition": "maxTurns & wealth>=70",
        "tone": "Prosperous Trader, Living Easy on the Waves"
      },
      {
        "condition": "maxTurns & ship>=75",
        "tone": "One Strong Ship, Roaming Free and Masterless"
      },
      {
        "condition": "maxTurns & ship>=50 & wealth>=40",
        "tone": "Sails Furled in Success, Returning Home to Retire"
      },
      {
        "condition": "maxTurns & wealth<=20 & ship<=30",
        "tone": "A Mediocre Life, Lost Among the Waves"
      },
      {
        "condition": "maxTurns & crew<=25",
        "tone": "Loyalties Scattered, Alone and Adrift"
      },
      {
        "condition": "maxTurns & wealth<=20",
        "tone": "Stone Broke, Scraping by to Survive"
      },
      {
        "condition": "maxTurns & ship<=30",
        "tone": "A Wreck Adrift, Surviving a Sea of Misery"
      },
      {
        "condition": "maxTurns",
        "tone": "A Dream of Furious Seas, Fading into the Ordinary"
      }
    ]
  },
  "liyuan": {
    "id": "liyuan",
    "title": "Dreams of the Pear Garden",
    "genre": "Republican Era",
    "intro": "The gong sounds, half the stage lights dim. In the Republican era, the bustling streets are alive with nightly revels. You are a performer in the opera troupe, having struggled through hardship to earn a place. On stage, your flowing sleeves and vocals enchant; off stage, patrons, appreciators, and admirers—from all walks of life—congregate. Warlords' banquets, newspapers' critiques, the troupe's bonds of loyalty—all drift in this chaotic world. Thirty years of painted face and silk robes; it all depends on how you use your voice.",
    "turnUnit": "Year",
    "attributes": [
      {
        "key": "art",
        "name": "Artistry",
        "bands": [
          "Novice Humblings",
          "Competent Foundation",
          "Leading Star Potential",
          "Famed Performer Presence",
          "Master of the Ages"
        ]
      },
      {
        "key": "fame",
        "name": "Reputation",
        "bands": [
          "Ruined Name",
          "Mixed Acclaim",
          "Quite Reputable",
          "Red-Hot and Beloved"
        ]
      },
      {
        "key": "safety",
        "name": "Safety",
        "bands": [
          "Hanging by a Thread",
          "Storm-Tossed and Unstable",
          "Able to Stand",
          "Stable and Respectable"
        ]
      }
    ],
    "openings": [
      {
        "name": "Troupe Apprentice",
        "prompt": "Sold into the opera troupe as a child, beaten and trained relentlessly since dawn. Every skill was earned through blood and sweat; alone in the world, with no family to lean on."
      },
      {
        "name": "Fallen Aristocrat's Daughter",
        "prompt": "The daughter of a once-prominent official family, reduced to singing opera against her family's wishes, carrying a trace of scholarly pride and unyielding spirit."
      },
      {
        "name": "Amateur Turned Professional",
        "prompt": "Once a wealthy dilettante, obsessed with opera and often performing as a hobby. A change in fortune or sheer boldness led to formally joining a troupe—shallow roots but extensive connections and vast experience."
      }
    ],
    "ambitions": [
      "Become a top leading actor revered in Beijing and Shanghai",
      "Uphold my art and integrity, keeping my honor unsullied",
      "Find a kindred soul to share my life",
      "Revive my family's fallen opera troupe",
      "Survive the chaos and protect my life and family",
      "Create a signature masterpiece that will endure through the ages",
      "Innovate and push the boundaries of traditional opera",
      "Protect the entire troupe through turbulent times",
      "Rival the leading actor of a competing troupe and outshine them all",
      "Spread this national treasure beyond the bustling streets, gaining fame worldwide"
    ],
    "endings": [
      {
        "condition": "safety<=-1",
        "tone": "Offended the Powerful, Died in the Chaos"
      },
      {
        "condition": "safety<=-1",
        "tone": "Reputation Ruined, Stage Lights Extinguished"
      },
      {
        "condition": "maxTurns & has(一夜爆红) & fame>=60",
        "tone": "Overnight Star, Prodigy of the Opera World"
      },
      {
        "condition": "safety<=0",
        "tone": "Penniless and Ill, a Desolate End"
      },
      {
        "condition": "safety<=0",
        "tone": "Exhausted Beyond Limits, Died on Stage"
      },
      {
        "condition": "safety<=0",
        "tone": "Robbed on the Road, Buried in the Wilderness"
      },
      {
        "condition": "safety<=0",
        "tone": "Tied to Rebels, Erased by Force"
      },
      {
        "condition": "safety<=0",
        "tone": "Drowning in Debt, Nowhere to Turn"
      },
      {
        "condition": "safety<=0",
        "tone": "Scattered by War, Frozen in the Ditches"
      },
      {
        "condition": "safety<=0",
        "tone": "Fallen into Indulgence, Dragging On in Shame"
      },
      {
        "condition": "fame<=0",
        "tone": "Ruined Reputation, Ashamed to Face the World"
      },
      {
        "condition": "maxTurns & art>=96 & fame>=70",
        "tone": "Grand Master, Founder of a New School"
      },
      {
        "condition": "maxTurns & art>=96",
        "tone": "Supreme in Artistry, A Lonely Height"
      },
      {
        "condition": "maxTurns & fame>=96",
        "tone": "Blazing Red Across the Sky, Streets Emptied"
      },
      {
        "condition": "fame<=6",
        "tone": "Infamy Spreads, Spit Upon by All"
      },
      {
        "condition": "safety<=6 & art<=25 & fame<=25",
        "tone": "A Bitter Extra, Dying on the Streets"
      },
      {
        "condition": "safety<=6 & art>=70 & has(戏班学徒)",
        "tone": "Weakened by Training, Coughed Blood and Died"
      },
      {
        "condition": "safety<=6 & art>=70 & has(落魄世家小姐)",
        "tone": "Proud and Skilled, Died in Sorrow"
      },
      {
        "condition": "safety<=6 & art>=70 & has(票友下海)",
        "tone": "Amateur Devoted to Art, Burned Out and Died"
      },
      {
        "condition": "safety<=6 & art>=85",
        "tone": "Art Reaching Perfection, Heart and Soul Exhausted"
      },
      {
        "condition": "safety<=6 & art>=70",
        "tone": "Skilled but Envied, Silently Murdered"
      },
      {
        "condition": "safety<=6 & fame>=70 & has(戏班学徒)",
        "tone": "Risen from the Bottom, Fell at the Peak"
      },
      {
        "condition": "safety<=6 & fame>=70 & has(落魄世家小姐)",
        "tone": "Sensational for a Moment, Gone in Splendor"
      },
      {
        "condition": "safety<=6 & fame>=70 & has(票友下海)",
        "tone": "Playing the Fool, Tragedy from Excess"
      },
      {
        "condition": "safety<=6 & fame>=70",
        "tone": "Red Hot and Dying Young, a Blaze Cut Short"
      },
      {
        "condition": "safety<=6 & fame<=20",
        "tone": "Drifting without Shelter, Died in a Strange Land"
      },
      {
        "condition": "safety<=6 & art>=45",
        "tone": "Mad for the Art, Lost to Frenzy"
      },
      {
        "condition": "safety<=6 & fame>=40",
        "tone": "Fame and Skill Hollow, All Came to Nothing"
      },
      {
        "condition": "safety<=6",
        "tone": "Lamp Dimming, Barely Clinging to Life"
      },
      {
        "condition": "maxTurns & has(琴师) & art>=50",
        "tone": "Strings in Harmony, Soulmates for Life"
      },
      {
        "condition": "maxTurns & has(戏班学徒) & art>=85",
        "tone": "Trained with Blood and Sweat, Finally a Leading Star"
      },
      {
        "condition": "maxTurns & has(落魄世家小姐) & fame>=80",
        "tone": "Noble Blood, Dazzling All Four Corners"
      },
      {
        "condition": "maxTurns & has(票友下海) & fame>=72",
        "tone": "Amateur Turned Star, Hallmark of the Pear Garden"
      },
      {
        "condition": "maxTurns & art>=80 & fame>=75 & safety>=60",
        "tone": "Perfection in Art and Name, Patriarch of the Pear Garden"
      },
      {
        "condition": "maxTurns & fame>=85 & art>=60",
        "tone": "Virtue and Talent, Model of the Opera World"
      },
      {
        "condition": "maxTurns & art>=80 & fame>=70",
        "tone": "Renowned in Beijing and Shanghai, A Star of the Era"
      },
      {
        "condition": "maxTurns & art>=80 & fame<=20",
        "tone": "Talented but Tainted, Arrogant and Wild"
      },
      {
        "condition": "maxTurns & art>=75 & safety>=60",
        "tone": "Art Achieved, Retiring Gracefully"
      },
      {
        "condition": "maxTurns & fame>=80 & art>=45",
        "tone": "Widespread Fame, Praised by All"
      },
      {
        "condition": "maxTurns & art>=80 & fame<=30",
        "tone": "Skillful but Cold, Admired from Afar"
      },
      {
        "condition": "maxTurns & art>=75",
        "tone": "Gifted with Rare Artistry, Famous in a Corner"
      },
      {
        "condition": "maxTurns & fame>=70",
        "tone": "Enduring Popularity, Lasting Reputation"
      },
      {
        "condition": "maxTurns & art>=45 & safety>=50",
        "tone": "Retiring Before the Tide, Returning to Rural Peace"
      },
      {
        "condition": "maxTurns & fame<=25 & art<=30",
        "tone": "A Mediocre Life, Lost Among the Crowd"
      },
      {
        "condition": "maxTurns & safety<=30",
        "tone": "Wracked with Injury and Illness, Barely Getting By"
      },
      {
        "condition": "maxTurns & fame<=25",
        "tone": "Mixed Reputation, Retiring in Disgrace"
      },
      {
        "condition": "maxTurns & art>=45",
        "tone": "A Minor Fame, Touring Ends in Old Age"
      },
      {
        "condition": "maxTurns",
        "tone": "Life a Dream, Fading into the Ordinary"
      }
    ]
  }
};
