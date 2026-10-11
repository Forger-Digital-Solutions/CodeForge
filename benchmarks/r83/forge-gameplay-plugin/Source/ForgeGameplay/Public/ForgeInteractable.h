#pragma once

#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "ForgeInteractable.generated.h"

UINTERFACE(BlueprintType, MinimalAPI)
class UForgeInteractable : public UInterface
{
	GENERATED_BODY()
};

/**
 * Reusable interaction contract. Any world object a player can use — doors,
 * windows, storage, furniture, workstations — implements this interface and is
 * discovered through targeting, never by name.
 */
class FORGEGAMEPLAY_API IForgeInteractable
{
	GENERATED_BODY()
public:
	virtual bool ForgeCanInteract(AActor* Interactor) const = 0;
	virtual void ForgeInteract(AActor* Interactor) = 0;
	virtual FName ForgeGetInteractState() const = 0;
};
