// Built-in race texts. Add more lines to either list any time.
const TEXTS = {
  bn: [
    "বাংলাদেশের প্রকৃতি অপরূপ সুন্দর। সবুজ মাঠ, নদী আর পাহাড় মিলেমিশে এক অনন্য দৃশ্য তৈরি করে।",
    "শিক্ষাই জাতির মেরুদণ্ড। শিক্ষিত জাতিই উন্নত জাতি। তাই সবাইকে শিক্ষিত হতে হবে।",
    "সময়ের মূল্য অপরিসীম। সময় নষ্ট না করে কাজে লাগাতে হবে। সময় চলে গেলে আর ফিরে আসে না।",
    "ভোরবেলা পাখির ডাকে ঘুম ভাঙে। জানালা দিয়ে নরম রোদ এসে ঘরের মেঝেতে ছড়িয়ে পড়ে। নতুন একটি দিন শুরু হয়।",
    "বইয়ের মতো বন্ধু আর নেই। বই আমাদের জ্ঞান দেয়, কল্পনার জগতে নিয়ে যায় এবং মানুষ হিসেবে গড়ে তোলে।",
    "পরিশ্রম সৌভাগ্যের চাবিকাঠি। যে মানুষ নিয়মিত চেষ্টা করে, একদিন সে অবশ্যই সফল হয়।",
    "বর্ষাকালে আকাশ কালো মেঘে ঢেকে যায়। ঝমঝম বৃষ্টিতে নদী-নালা ভরে ওঠে আর কৃষকের মুখে হাসি ফোটে।",
    "পাহাড়ে ওঠা সহজ নয়, কিন্তু চূড়ায় পৌঁছে চারপাশের দৃশ্য দেখলে সব কষ্ট ভুলে যাওয়া যায়।",
    "সত্য কথা বলা মহৎ গুণ। সত্যবাদী মানুষকে সবাই বিশ্বাস করে এবং সম্মান করে।",
    "আমাদের মাতৃভাষা বাংলা। ভাষার জন্য প্রাণ দিয়েছেন আমাদের বীর সন্তানরা, তাই এই ভাষা আমাদের গর্ব।"
  ],
  en: [
    "The greatest glory in living lies not in never falling, but in rising every time we fall.",
    "Learning a new language opens many doors. It helps you understand different cultures and people around the world.",
    "Time is the most valuable resource we have. Once it is gone, you cannot get it back. Use it wisely every day.",
    "A journey of a thousand miles begins with a single step. Keep moving forward, even when the path feels steep.",
    "The mountain does not care how fast you climb. It only asks that you keep going until you reach the top.",
    "Good typing is built on rhythm and accuracy. Slow down a little, stay relaxed, and speed will follow naturally.",
    "Reading every day sharpens the mind. A good book can take you to faraway places without leaving your chair.",
    "Success is the sum of small efforts repeated day in and day out. Practice a little today and again tomorrow.",
    "Rain tapped softly on the window while the town slept. By morning, the streets were shining under a clear blue sky.",
    "Teamwork makes hard things possible. When everyone pulls in the same direction, even the tallest peak feels closer."
  ]
};

function pickText(lang, exclude) {
  const list = TEXTS[lang] || TEXTS.en;
  if (list.length === 1) return list[0];
  let t;
  do {
    t = list[Math.floor(Math.random() * list.length)];
  } while (t === exclude);
  return t;
}

// 'bn' if the text contains any Bengali-script character, else 'en'
function detectLanguage(text) {
  return /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en';
}

module.exports = { TEXTS, pickText, detectLanguage };
