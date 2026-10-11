#include "ForgeGameplayMode.h"

#include "ForgeInteractCharacter.h"

AForgeGameplayMode::AForgeGameplayMode()
{
	DefaultPawnClass = AForgeInteractCharacter::StaticClass();
}
