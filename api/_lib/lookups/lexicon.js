/**
 * R31: the chatter / function-word lexicon shared by slotFill.js and technician.js (no imports, so neither can be caught in the
 * slotFill -> contactLookup -> technician import cycle with an uninitialized binding).
 */
export const LEX = new Set(
  (
    "what whats what's which where wheres where's who whos who's whose is are do does we have has got on file for of the a an at to in by with and my our their his her its " +
    "i me you us them they it this that there here please pls plz thanks thank thx ok okay hey hi hello yo um uh umm erm er mm mmm hmm so like just quick real really " +
    "actually right well then now again sorry bug boss asked wants want know tell give get pull up look lookup check find need can could would will should " +
    "customer client account unit system place house job site location located service mobile cell cellphone telephone contact call reach dial best way " +
    "phone number email e-mail mail address serial model brand manufacturer make tonnage name owner tenant resident lives live living stays " +
    "sit sits sitting go going info information details anything show one sec second minute moment hold hang gimme let see whenever asap sir buddy mate cheers lol haha " +
    "ring callback callbacks known thats that's anyway thing question good morning afternoon evening ph # no. nr num wait ah oh sure alright folks guys team someone somebody anyone today forgot remember remind thx yeah yep hiya howdy dear boss manager office file whichever whatever kindly"
  ).split(/\s+/)
);
