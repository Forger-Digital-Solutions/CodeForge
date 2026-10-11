#pragma once

#include "CoreMinimal.h"
#include "GameFramework/SaveGame.h"
#include "ForgeDoorSaveGame.generated.h"

/** Stable door states only — transitional states are never written. */
USTRUCT()
struct FForgeDoorRecord
{
	GENERATED_BODY()

	UPROPERTY()
	uint8 State = 0;

	UPROPERTY()
	float LeafYawDeg = 0.f;
};

/**
 * Versioned per-instance door persistence. One slot holds every placed door's
 * record keyed by DoorInstanceId, so two doors built from the same module keep
 * independent state.
 */
USTRUCT()
struct FForgeWindowRecord
{
    GENERATED_BODY()
    UPROPERTY() int32 SchemaVersion = 1;
    UPROPERTY() uint8 State = 0;
    UPROPERTY() float SlideCm = 0.f;
};

UCLASS()
class FORGEGAMEPLAY_API UForgeDoorSaveGame : public USaveGame
{
	GENERATED_BODY()
public:
	static const int32 CurrentSchemaVersion = 1;

	UPROPERTY()
	int32 SchemaVersion = CurrentSchemaVersion;

	UPROPERTY()
	TMap<FName, FForgeDoorRecord> Doors;

    // Keep the R81 class, version and Doors fields readable; old saves deserialize an empty Windows map.
    UPROPERTY()
    TMap<FName, FForgeWindowRecord> Windows;
};
