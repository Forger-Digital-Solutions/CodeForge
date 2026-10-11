#include "ForgeInteractableWindow.h"
#include "Components/StaticMeshComponent.h"
#include "ForgeDoorSaveGame.h"
#include "ForgeInteractableDoor.h"
#include "Kismet/GameplayStatics.h"

AForgeInteractableWindow::AForgeInteractableWindow()
{
    PrimaryActorTick.bCanEverTick = true;
    WindowRoot = CreateDefaultSubobject<USceneComponent>(TEXT("WindowRoot"));
    SetRootComponent(WindowRoot);
    FrameMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("FrameMesh"));
    FrameMesh->SetupAttachment(WindowRoot);
    SlidePivot = CreateDefaultSubobject<USceneComponent>(TEXT("SlidePivot"));
    SlidePivot->SetupAttachment(WindowRoot);
    SashMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("SashMesh"));
    SashMesh->SetupAttachment(SlidePivot);
    SashMesh->SetMobility(EComponentMobility::Movable);
    SashMesh->SetCollisionProfileName(TEXT("BlockAll"));
}

void AForgeInteractableWindow::BeginPlay()
{
    Super::BeginPlay();
    if (WindowInstanceId.IsNone()) WindowInstanceId = GetFName();
    bRestored = ApplyRestoredState();
}

bool AForgeInteractableWindow::ForgeCanInteract(AActor* Interactor) const
{
    return Interactor && FVector::Dist(Interactor->GetActorLocation(), GetActorLocation()) <= 150.f
        && FMath::IsFinite(OpenTravelCm) && OpenTravelCm > 0.f && OpenTravelCm <= 100.f
        && FMath::IsFinite(TransitionS) && TransitionS > 0.f;
}

void AForgeInteractableWindow::ForgeInteract(AActor* Interactor)
{
    if (!ForgeCanInteract(Interactor)) return;
    WindowState = (WindowState == EForgeWindowState::Closed || WindowState == EForgeWindowState::Closing)
        ? EForgeWindowState::Opening : EForgeWindowState::Closing;
}

FName AForgeInteractableWindow::ForgeGetInteractState() const
{
    switch (WindowState) {
    case EForgeWindowState::Closed: return TEXT("window.closed");
    case EForgeWindowState::Opening: return TEXT("window.opening");
    case EForgeWindowState::Open: return TEXT("window.open");
    case EForgeWindowState::Closing: return TEXT("window.closing");
    }
    return TEXT("window.invalid");
}

void AForgeInteractableWindow::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
    if (WindowState != EForgeWindowState::Opening && WindowState != EForgeWindowState::Closing) return;
    const bool bOpening = WindowState == EForgeWindowState::Opening;
    const float Target = bOpening ? OpenTravelCm : 0.f;
    SlideCm = FMath::FInterpConstantTo(SlideCm, Target, DeltaSeconds, OpenTravelCm / FMath::Max(TransitionS, 0.01f));
    SlidePivot->SetRelativeLocation(FVector(0.f, 0.f, SlideCm));
    if (FMath::IsNearlyEqual(SlideCm, Target)) {
        WindowState = bOpening ? EForgeWindowState::Open : EForgeWindowState::Closed;
        if (bAutoPersist) PersistWindowState();
    }
}

bool AForgeInteractableWindow::PersistWindowState()
{
    if (WindowState != EForgeWindowState::Open && WindowState != EForgeWindowState::Closed) return false;
    UForgeDoorSaveGame* Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::LoadGameFromSlot(AForgeInteractableDoor::GetSaveSlotName(), 0));
    if (!Save) Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::CreateSaveGameObject(UForgeDoorSaveGame::StaticClass()));
    if (!Save || Save->SchemaVersion != UForgeDoorSaveGame::CurrentSchemaVersion || WindowInstanceId.IsNone()) return false;
    FForgeWindowRecord& Record = Save->Windows.FindOrAdd(WindowInstanceId);
    Record.SchemaVersion = 1;
    Record.State = (uint8)WindowState;
    Record.SlideCm = SlideCm;
    return UGameplayStatics::SaveGameToSlot(Save, AForgeInteractableDoor::GetSaveSlotName(), 0);
}

bool AForgeInteractableWindow::ApplyRestoredState()
{
    UForgeDoorSaveGame* Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::LoadGameFromSlot(AForgeInteractableDoor::GetSaveSlotName(), 0));
    if (!Save || Save->SchemaVersion != UForgeDoorSaveGame::CurrentSchemaVersion) return false;
    const FForgeWindowRecord* Record = Save->Windows.Find(WindowInstanceId);
    if (!Record || Record->SchemaVersion != 1 || !FMath::IsFinite(Record->SlideCm)) return false;
    if (Record->State != (uint8)EForgeWindowState::Open && Record->State != (uint8)EForgeWindowState::Closed) return false;
    const float Target = Record->State == (uint8)EForgeWindowState::Open ? OpenTravelCm : 0.f;
    if (!FMath::IsNearlyEqual(Record->SlideCm, Target, 0.1f)) return false;
    WindowState = (EForgeWindowState)Record->State;
    SlideCm = Target;
    SlidePivot->SetRelativeLocation(FVector(0.f, 0.f, SlideCm));
    return true;
}
