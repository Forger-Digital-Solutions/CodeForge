#include "ForgeInteractableDoor.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "ForgeDoorSaveGame.h"
#include "Kismet/GameplayStatics.h"

namespace
{
	const TCHAR* ForgeDoorSlot = TEXT("ForgeR81DoorTest");
}

const FString& AForgeInteractableDoor::GetSaveSlotName()
{
    static FString Slot;
    if (Slot.IsEmpty()) {
        FString Candidate;
        FParse::Value(FCommandLine::Get(), TEXT("ForgeSaveSlot="), Candidate);
        bool bSafe = !Candidate.IsEmpty() && Candidate.Len() <= 64;
        for (TCHAR C : Candidate) bSafe = bSafe && (FChar::IsAlnum(C) || C == '_' || C == '-');
        Slot = bSafe ? Candidate : FString(ForgeDoorSlot);
    }
	return Slot;
}

AForgeInteractableDoor::AForgeInteractableDoor()
{
	PrimaryActorTick.bCanEverTick = true;
	DoorRoot = CreateDefaultSubobject<USceneComponent>(TEXT("DoorRoot"));
	SetRootComponent(DoorRoot);
	HingePivot = CreateDefaultSubobject<USceneComponent>(TEXT("HingePivot"));
	HingePivot->SetupAttachment(DoorRoot);
	// Hinge line at the left doorjamb (R80 rig convention); the leaf mesh's own
	// pivot is centered, so it sits +48 under the hinge to cover the doorway.
	HingePivot->SetRelativeLocation(FVector(-48.f, 0.f, 0.f));
	FrameMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("FrameMesh"));
	FrameMesh->SetupAttachment(DoorRoot);
	LeafMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("LeafMesh"));
	LeafMesh->SetupAttachment(HingePivot);
	LeafMesh->SetRelativeLocation(FVector(48.f, 0.f, 0.f));
	LeafMesh->SetMobility(EComponentMobility::Movable);
}

void AForgeInteractableDoor::BeginPlay()
{
	Super::BeginPlay();
	if (DoorInstanceId.IsNone())
	{
		// The placed actor name is serialized into the level — a durable,
		// duplicate-free identity suitable for save records.
		DoorInstanceId = FName(*GetName());
	}
	ApplyRestoredState();
}

void AForgeInteractableDoor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (DoorState != EForgeDoorState::Opening && DoorState != EForgeDoorState::Closing)
	{
		return;
	}
	const float Target = TargetYawForState(DoorState);
	const float Rate = FMath::Abs(OpenAngleDeg) / FMath::Max(TransitionS, KINDA_SMALL_NUMBER);
	const float Step = Rate * DeltaSeconds;
	const float Delta = Target - LeafYawDeg;
	if (FMath::Abs(Delta) <= Step)
	{
		LeafYawDeg = Target;
		DoorState = (DoorState == EForgeDoorState::Opening) ? EForgeDoorState::Open : EForgeDoorState::Closed;
		if (bAutoPersist)
		{
			PersistDoorState();
		}
	}
	else
	{
		LeafYawDeg += FMath::Sign(Delta) * Step;
	}
	HingePivot->SetRelativeRotation(FRotator(0.f, LeafYawDeg, 0.f));
}

bool AForgeInteractableDoor::ForgeCanInteract(AActor* /*Interactor*/) const
{
	return true;
}

void AForgeInteractableDoor::ForgeInteract(AActor* /*Interactor*/)
{
	switch (DoorState)
	{
	case EForgeDoorState::Closed:
	case EForgeDoorState::Closing:
		DoorState = EForgeDoorState::Opening;
		break;
	case EForgeDoorState::Open:
	case EForgeDoorState::Opening:
		DoorState = EForgeDoorState::Closing;
		break;
	}
}

FName AForgeInteractableDoor::ForgeGetInteractState() const
{
	return StableStateName(DoorState);
}

FName AForgeInteractableDoor::StableStateName(EForgeDoorState State)
{
	switch (State)
	{
	case EForgeDoorState::Closed: return TEXT("door.closed");
	case EForgeDoorState::Opening: return TEXT("door.opening");
	case EForgeDoorState::Open: return TEXT("door.open");
	case EForgeDoorState::Closing: return TEXT("door.closing");
	}
	return TEXT("door.unknown");
}

float AForgeInteractableDoor::TargetYawForState(EForgeDoorState State) const
{
	switch (State)
	{
	case EForgeDoorState::Open:
	case EForgeDoorState::Opening:
		return OpenAngleDeg;
	default:
		return 0.f;
	}
}

bool AForgeInteractableDoor::PersistDoorState()
{
	if (DoorState != EForgeDoorState::Closed && DoorState != EForgeDoorState::Open)
	{
		return false;
	}
	UForgeDoorSaveGame* Save = nullptr;
	if (UGameplayStatics::DoesSaveGameExist(GetSaveSlotName(), 0))
	{
		Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::LoadGameFromSlot(GetSaveSlotName(), 0));
	}
	if (Save == nullptr)
	{
		Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::CreateSaveGameObject(UForgeDoorSaveGame::StaticClass()));
	}
	if (Save == nullptr || Save->SchemaVersion != UForgeDoorSaveGame::CurrentSchemaVersion)
	{
		return false;
	}
	FForgeDoorRecord& Record = Save->Doors.FindOrAdd(DoorInstanceId);
	Record.State = (DoorState == EForgeDoorState::Open) ? (uint8)EForgeDoorState::Open : (uint8)EForgeDoorState::Closed;
	Record.LeafYawDeg = LeafYawDeg;
	return UGameplayStatics::SaveGameToSlot(Save, GetSaveSlotName(), 0);
}

bool AForgeInteractableDoor::ApplyRestoredState()
{
	if (!UGameplayStatics::DoesSaveGameExist(GetSaveSlotName(), 0))
	{
		return false;
	}
	USaveGame* Raw = UGameplayStatics::LoadGameFromSlot(GetSaveSlotName(), 0);
	UForgeDoorSaveGame* Save = Cast<UForgeDoorSaveGame>(Raw);
	if (Save == nullptr || Save->SchemaVersion != UForgeDoorSaveGame::CurrentSchemaVersion)
	{
		return false;
	}
	const FForgeDoorRecord* Record = Save->Doors.Find(DoorInstanceId);
	if (Record == nullptr)
	{
		return false;
	}
	// Normalize any non-stable record to the nearest stable state — a door
	// serialized mid-transition resumes as its settled equivalent.
	bool bOpen;
	if (Record->State == (uint8)EForgeDoorState::Open)
	{
		bOpen = true;
	}
	else if (Record->State == (uint8)EForgeDoorState::Closed)
	{
		bOpen = false;
	}
	else
	{
		bOpen = FMath::Abs(Record->LeafYawDeg - OpenAngleDeg) < FMath::Abs(Record->LeafYawDeg);
	}
	DoorState = bOpen ? EForgeDoorState::Open : EForgeDoorState::Closed;
	LeafYawDeg = bOpen ? OpenAngleDeg : 0.f;
	HingePivot->SetRelativeRotation(FRotator(0.f, LeafYawDeg, 0.f));
	return true;
}
