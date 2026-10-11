#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Dom/JsonObject.h"
#include "ForgeDoorTestDriver.generated.h"

class AForgeInteractCharacter;
class AForgeInteractableDoor;

/**
 * Native scripted verifier placed in a test map. Reads a JSON spec from the
 * -ForgeDriverSpec command-line argument, then drives the possessed pawn and
 * doors entirely through gameplay APIs: AddMovementInput for motion, real
 * PlayerInput::InputKey injection for interact presses (SYNTHETIC_INPUT — the
 * same action-mapping path a physical key takes), native SaveGame for
 * persistence, OpenLevel for in-process restart, and observed component
 * transforms for all assertions. Writes a JSON report the external harness
 * consumes; no Python anywhere in the loop.
 */
UCLASS()
class FORGEGAMEPLAY_API AForgeDoorTestDriver : public AActor
{
	GENERATED_BODY()
public:
	AForgeDoorTestDriver();
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

private:
	struct FActionState
	{
		float Elapsed = 0.f;
		FVector Start = FVector::ZeroVector;
		TArray<TSharedPtr<FJsonValue>> Samples;
		TSharedPtr<FJsonObject> Record;
		float LastProgressSample = 0.f;
		float StallTime = 0.f;
	};

	bool LoadSpec();
	bool ResumeFromCheckpoint();
	void WriteCheckpoint(int32 ResumeIndex);
	void FinishReport();
	void ExitGame();
	AForgeInteractCharacter* ResolvePawn() const;
	AForgeInteractableDoor* FindDoor(const FString& IdOrName) const;
	FVector DoorWorldPos(const AForgeInteractableDoor* Door) const;
	double ObservedDoorYaw(const AForgeInteractableDoor* Door) const;
	void StartAction(const TSharedPtr<FJsonObject>& Action);
	void TickAction(float DeltaSeconds);
	void Sample();

	FString SpecPath;
	FString ReportPath;
	FString CheckpointPath;
	FString SaveSlot;
	FString MapPackage;
	FString RunId;
	TArray<TSharedPtr<FJsonObject>> Actions;
	TArray<TSharedPtr<FJsonValue>> Completed;
	TArray<FString> Errors;
	int32 CurrentIndex = 0;
	FActionState Cur;
	bool bStarted = false;
	bool bFinished = false;
	float Clock = 0.f;
};
